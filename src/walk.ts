import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page, Response } from "playwright";

// Exit codes: 0 done and report written, 2 refused before any work, 1 anything unexpected.
// Lines the skills read ("shot list ok", "session rejected", ...) go to stdout.

const KIT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const WIDTH = 1920;
const HEIGHT = 1080;
const SETTLE_TIMEOUT_MS = 15_000;
const CLICK_TIMEOUT_MS = 5_000;

type Route = { surface: string; route: string; settle: string; clicks: string[]; fallback: string };
type Shot = { n: number; surface: string; route: string; dwell: number; clicks: string[]; caption: string };
type ShotList = { date: string; shots: Shot[] };
type ShotResult = {
  n: number;
  surface: string;
  route: string;
  ok: boolean;
  file: string;
  seconds: number;
  status: "recorded" | "failed";
  error: string;
  usedFallback: boolean;
};
type Report = { date: string; synthetic: boolean; shots: ShotResult[]; recorded: number; failed: number };

function loadRoutes(): Route[] {
  const parsed = JSON.parse(readFileSync(join(KIT_ROOT, "routes.json"), "utf8"));
  return parsed.routes as Route[];
}

function ownerOf(routes: Route[], path: string): Route | undefined {
  return routes.find((r) => r.route === path) ?? routes.find((r) => r.fallback === path);
}

// The page opened for a shot, and whether it is a fallback path: --only, or a route that
// is some entry's fallback and no entry's route.
function pageFor(routes: Route[], shot: Shot, only: boolean): { route: string; usedFallback: boolean } {
  const route = only ? ownerOf(routes, shot.route)!.fallback : shot.route;
  const usedFallback = only || (routes.some((r) => r.fallback === route) && !routes.some((r) => r.route === route));
  return { route, usedFallback };
}

// An untrusted value as it appears in a printed line: JSON-quoted, so a line break or an
// escape sequence in a shot list can never start a line of its own. JSON.stringify leaves
// DEL, the C1 controls and the Unicode line separators raw; those are escaped too.
export function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A real calendar date written YYYY-MM-DD, the same check render makes.
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Returns the shot list when it is valid, else one problem per entry.
export function validateShotList(raw: unknown, routes: Route[]): { list?: ShotList; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { problems: ["shot list is not a JSON object"] };
  if (!isIsoDate(raw.date)) problems.push("date must be a real date written YYYY-MM-DD");
  if (!Array.isArray(raw.shots)) return { problems: [...problems, "shots is not a list"] };
  if (raw.shots.length === 0) problems.push("shot list has no shots");
  if (raw.shots.length > 12) problems.push(`shot list has ${raw.shots.length} shots, at most 12`);

  const seen = new Set<unknown>();
  raw.shots.forEach((entry, index) => {
    const label = isObject(entry) && Number.isInteger(entry.n) ? `shot ${entry.n}` : `shot at position ${index + 1}`;
    if (!isObject(entry)) {
      problems.push(`${label}: not an object`);
      return;
    }
    if (!Number.isInteger(entry.n) || (entry.n as number) < 1) problems.push(`${label}: n is not a positive whole number`);
    else if (seen.has(entry.n)) problems.push(`${label}: n repeats`);
    else seen.add(entry.n);

    if (typeof entry.surface !== "string") problems.push(`${label}: surface is missing`);
    if (typeof entry.dwell !== "number" || !Number.isFinite(entry.dwell) || entry.dwell < 3 || entry.dwell > 20) {
      problems.push(`${label}: dwell must be a number from 3 to 20`);
    }
    if (typeof entry.caption !== "string" || entry.caption === "" || [...entry.caption].length > 60) {
      problems.push(`${label}: caption must be 1 to 60 characters`);
    }

    let owner: Route | undefined;
    if (typeof entry.route !== "string") problems.push(`${label}: route is missing`);
    else {
      owner = ownerOf(routes, entry.route);
      if (!owner) problems.push(`${label}: route ${shown(entry.route)} is not in routes.json`);
      else if (typeof entry.surface === "string" && entry.surface !== owner.surface) {
        problems.push(
          `${label}: surface ${shown(entry.surface)} does not match ${shown(owner.surface)} for route ${shown(entry.route)}`,
        );
      }
    }

    if (!Array.isArray(entry.clicks) || entry.clicks.some((c) => typeof c !== "string")) {
      problems.push(`${label}: clicks must be a list of selectors`);
    } else if (owner) {
      for (const click of entry.clicks as string[]) {
        if (!owner.clicks.includes(click)) {
          problems.push(`${label}: click ${shown(click)} is not listed for ${shown(entry.route)}`);
        }
      }
    }
  });

  if (problems.length > 0) return { problems };
  return { list: { date: raw.date as string, shots: raw.shots as Shot[] }, problems };
}

export function newRecordingContext(browser: Browser, dir: string): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir, size: { width: WIDTH, height: HEIGHT } },
  });
}

const clipName = (n: number) => `shot-${String(n).padStart(2, "0")}.webm`;

function summarize(date: string, synthetic: boolean, shots: ShotResult[]): Report {
  const sorted = [...shots].sort((a, b) => a.n - b.n);
  return {
    date,
    synthetic,
    shots: sorted,
    recorded: sorted.filter((s) => s.status === "recorded").length,
    failed: sorted.filter((s) => s.status === "failed").length,
  };
}

function writeReport(out: string, date: string, synthetic: boolean, results: ShotResult[], merge: boolean): void {
  const reportPath = join(out, "walk-report.json");
  let report: Report;
  let existing: Partial<Report> | null = null;
  if (merge) {
    try {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
      if (isObject(parsed) && Array.isArray(parsed.shots)) existing = parsed as Partial<Report>;
    } catch {
      existing = null;
    }
  }
  if (existing) {
    const byN = new Map<number, ShotResult>();
    for (const s of existing.shots as ShotResult[]) byN.set(s.n, s);
    for (const s of results) byN.set(s.n, s);
    report = summarize(
      typeof existing.date === "string" ? existing.date : date,
      existing.synthetic === true && synthetic,
      [...byN.values()],
    );
  } else {
    report = summarize(date, synthetic, results);
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

function result(shot: Shot, route: string, usedFallback: boolean, error: string, seconds = shot.dwell): ShotResult {
  const ok = error === "";
  return {
    n: shot.n,
    surface: shot.surface,
    route,
    ok,
    file: ok ? clipName(shot.n) : "",
    seconds: ok ? seconds : 0,
    status: ok ? "recorded" : "failed",
    error,
    usedFallback,
  };
}

function synthetic(shots: Shot[], routes: Route[], out: string, only: boolean): ShotResult[] {
  const results: ShotResult[] = [];
  for (const shot of shots) {
    const { route, usedFallback } = pageFor(routes, shot, only);
    const file = join(out, clipName(shot.n));
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=${WIDTH}x${HEIGHT}:rate=30`,
        "-t", String(shot.dwell),
        "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "-threads", "4",
        "-pix_fmt", "yuv420p",
        file,
      ],
      { encoding: "utf8" },
    );
    if (ffmpeg.error) throw new Error("ffmpeg could not be started");
    if (ffmpeg.status !== 0) {
      rmSync(file, { force: true });
      results.push(result(shot, route, usedFallback, "clip not written"));
    } else {
      results.push(result(shot, route, usedFallback, ""));
    }
  }
  return results;
}

// A real clip is cut to the shot: from the moment the settle selector resolved to the end of
// the dwell. Playwright's video starts with the page, and its first frame comes a little after
// newPage() resolves, so an offset measured from there lands slightly late in the video, never
// early. SETTLE_MARGIN_MS adds a little more, for the paint that follows the selector.
const SETTLE_MARGIN_MS = 100;
// The page is held this long after the dwell, so the video runs past the cut's end.
const TAIL_MS = 800;
const TRIM_TIMEOUT_MS = 5 * 60 * 1000;

function runTool(command: string, args: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done({ status: null, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TRIM_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      done({ status: null, stdout: "" });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout });
    });
  });
}

// Re-encodes `raw` from `start` for `length` seconds into `target` (VP8, 1920x1080, 30 fps, as
// the synthetic clips), and returns the written clip's measured length in seconds, or null.
async function trimClip(raw: string, target: string, start: number, length: number): Promise<number | null> {
  const encode = await runTool("ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", start.toFixed(3), "-i", raw,
    "-t", length.toFixed(3),
    "-an",
    "-vf", `fps=30,scale=${WIDTH}:${HEIGHT}`,
    "-c:v", "libvpx", "-b:v", "4M", "-crf", "8", "-deadline", "realtime", "-cpu-used", "8", "-threads", "4",
    "-pix_fmt", "yuv420p",
    "-f", "webm",
    target,
  ]);
  if (encode.status !== 0) return null;
  const probe = await runTool("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  const seconds = Number(probe.stdout.trim());
  if (probe.status !== 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

type Session = { accessToken: string; expiresAt: number };

function readSession(file: string): Session | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const { accessToken, expiresAt } = parsed;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now() / 1000) return null;
  return { accessToken, expiresAt };
}

const guarded = new WeakMap<Page, Promise<void>>();

// Fails every top-level document request of the page whose origin is not the walk origin.
// This is done on the DevTools Fetch domain because context.route does not see the hops
// of a redirect chain: the browser would ask the other host before any handler ran.
// Sub-resources and frames other than the top one are not touched.
function holdToHost(context: BrowserContext, page: Page, origin: string, onBlocked: () => void): Promise<void> {
  const known = guarded.get(page);
  if (known) return known;
  const done = attachHold(context, page, origin, onBlocked);
  guarded.set(page, done);
  return done;
}

async function attachHold(context: BrowserContext, page: Page, origin: string, onBlocked: () => void): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const mainFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  cdp.on("Fetch.requestPaused", (event) => {
    let outside = event.frameId === mainFrameId;
    if (outside) {
      try {
        outside = new URL(event.request.url).origin !== origin;
      } catch {
        outside = true;
      }
    }
    if (outside) {
      onBlocked();
      cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    } else {
      cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    }
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
}

async function realWalk(
  shots: Shot[],
  routes: Route[],
  out: string,
  only: boolean,
  walkUrl: URL,
  session: Session,
): Promise<{ results: ShotResult[]; dead: boolean }> {
  const written: string[] = [];
  const results: ShotResult[] = [];
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const { route, usedFallback } = pageFor(routes, shot, only);
      // On a fallback page, settle on the entry whose route is that path, else body, and click nothing.
      const settle = routes.find((r) => r.route === route)?.settle ?? "body";
      const clicks = usedFallback ? [] : shot.clicks;
      const context = await newRecordingContext(browser, out);
      let videoPath = "";
      let error = "";
      let dead = false;
      let leftHost = false;
      let page: Page | undefined;
      // Wall-clock marks for the cut: the page made (the video starts with it), the settle
      // selector resolved, the dwell over.
      let pageAt = 0;
      let settledAt = 0;
      let endAt = 0;
      // Every page's video, popups included; all but the shot's own are removed after close.
      const videos: Promise<string>[] = [];
      context.on("page", (p) => {
        const video = p.video();
        if (video) videos.push(video.path());
      });
      try {
        // Popups. A page other than the shot's own never loads a document: its first
        // top-level request, and any later one, is aborted here. context.route sees a
        // popup's very first request (Playwright holds new targets until their routes are
        // in place), and since no popup document request is ever let through, none can
        // follow a redirect. One aimed at another origin fails the shot.
        await context.route("**/*", async (route, request) => {
          let top = true;
          let owner: Page | undefined;
          try {
            const frame = request.frame();
            top = frame.parentFrame() === null;
            owner = frame.page();
          } catch {
            owner = undefined;
          }
          if (request.resourceType() === "document" && top && (page === undefined || owner !== page)) {
            let outside = true;
            try {
              outside = new URL(request.url()).origin !== walkUrl.origin;
            } catch {
              outside = true;
            }
            if (outside) leftHost = true;
            await route.abort("blockedbyclient").catch(() => {});
            return;
          }
          await route.fallback().catch(() => {});
        });
        const cookie = (name: string) => ({
          name,
          value: session.accessToken,
          domain: walkUrl.hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax" as const,
          secure: walkUrl.protocol === "https:",
          expires: session.expiresAt,
        });
        await context.addCookies([cookie("access_token"), cookie("refresh_token")]);
        page = await context.newPage();
        pageAt = Date.now();
        // The shot's own page: every top-level document request, redirect hops included.
        await holdToHost(context, page, walkUrl.origin, () => {
          leftHost = true;
        });
        const video = page.video();
        if (video) videoPath = await video.path();
        if (videoPath) written.push(videoPath);

        const target = new URL(route, walkUrl);
        let response: Response | null = null;
        if (target.origin !== walkUrl.origin) error = "route leaves the walk host";
        else {
          try {
            response = await page.goto(target.href, { waitUntil: "domcontentloaded" });
          } catch {
            error = leftHost ? "route leaves the walk host" : "page did not load";
          }
        }
        if (leftHost && error !== "") error = "route leaves the walk host";
        // Any shot whose first navigation lands on /login: the session is dead.
        if (error === "" && new URL(page.url()).pathname === "/login") dead = true;
        if (error === "" && !dead) {
          if (response === null) error = "page did not answer";
          else if (response.status() >= 400) error = `page answered ${response.status()}`;
        }
        if (error === "" && !dead) {
          try {
            await page.waitForSelector(settle, { timeout: SETTLE_TIMEOUT_MS });
            settledAt = Date.now();
          } catch {
            error = "settle selector not found";
          }
        }
        if (error === "" && !dead) {
          for (const click of clicks) {
            try {
              await page.locator(click).first().click({ timeout: CLICK_TIMEOUT_MS });
            } catch {
              error = "click target not found";
              break;
            }
          }
        }
        if (error === "" && !dead) {
          await page.waitForTimeout(shot.dwell * 1000);
          endAt = Date.now();
          await page.waitForTimeout(TAIL_MS);
        }
        if (leftHost && !dead) error = "route leaves the walk host";
      } catch {
        if (error === "") error = "shot failed";
      } finally {
        await context.close().catch(() => {});
        // A popup's video is never kept: nothing untracked lands in --out.
        for (const settled of await Promise.allSettled(videos)) {
          if (settled.status === "fulfilled" && settled.value !== videoPath) rmSync(settled.value, { force: true });
        }
      }

      if (dead) {
        for (const file of written) rmSync(file, { force: true });
        return { results, dead: true };
      }
      let seconds = 0;
      const trimmed = join(out, `.${clipName(shot.n)}.trim`);
      if (error === "" && videoPath) {
        // Cut to the settled page and the dwell, then put the cut in place under the clip's name.
        const start = (settledAt - pageAt + SETTLE_MARGIN_MS) / 1000;
        const length = (endAt - settledAt) / 1000;
        written.push(trimmed);
        const measured = await trimClip(videoPath, trimmed, Math.max(0, start), length);
        if (measured === null) error = "clip could not be trimmed";
        else {
          try {
            renameSync(trimmed, join(out, clipName(shot.n)));
            written[written.indexOf(trimmed)] = join(out, clipName(shot.n));
            rmSync(videoPath, { force: true });
            seconds = Math.round(measured * 10) / 10;
          } catch {
            error = "clip not written";
          }
        }
      } else if (error === "") {
        error = "clip not written";
      }
      if (error !== "") {
        if (videoPath) rmSync(videoPath, { force: true });
        rmSync(trimmed, { force: true });
        rmSync(join(out, clipName(shot.n)), { force: true });
      }
      results.push(result(shot, route, usedFallback, error, seconds));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { results, dead: false };
}

async function main(): Promise<number> {
  let values: { shotlist?: string; out?: string; "dry-run"?: boolean; synthetic?: boolean; only?: string };
  try {
    values = parseArgs({
      options: {
        shotlist: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        synthetic: { type: "boolean" },
        only: { type: "string" },
      },
    }).values;
  } catch (error) {
    // The message can quote an argument: keep it on one line.
    console.log(`walk: ${shown((error as Error).message).slice(1, -1)}`);
    return 2;
  }
  if (!values.shotlist) {
    console.log("walk: --shotlist <path> is required");
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  if (!dryRun && !values.out) {
    console.log("walk: --out <dir> is required unless --dry-run");
    return 2;
  }
  let onlyN: number | undefined;
  if (values.only !== undefined) {
    if (!/^[0-9]+$/.test(values.only)) {
      console.log("walk: --only wants a shot number");
      return 2;
    }
    onlyN = Number(values.only);
  }

  const base = process.env.INIT_CWD || process.cwd();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(base, values.shotlist), "utf8"));
  } catch {
    console.log("shot list cannot be read as JSON");
    return 2;
  }
  const { list, problems } = validateShotList(raw, loadRoutes());
  if (!list) {
    for (const problem of problems) console.log(problem);
    return 2;
  }
  if (dryRun) {
    console.log(`shot list ok: ${list.shots.length} shots`);
    return 0;
  }

  const routes = loadRoutes();
  const out = resolve(base, values.out!);
  const only = onlyN !== undefined;
  const shots = only ? list.shots.filter((s) => s.n === onlyN) : list.shots;
  if (shots.length === 0) {
    console.log(`shot ${onlyN} is not in the shot list`);
    return 2;
  }

  if (values.synthetic) {
    mkdirSync(out, { recursive: true });
    writeReport(out, list.date, true, synthetic(shots, routes, out, only), only);
    return 0;
  }

  const rawUrl = process.env.NABB_WALK_URL;
  if (!rawUrl) {
    console.log("NABB_WALK_URL is not set");
    return 2;
  }
  let walkUrl: URL;
  try {
    walkUrl = new URL(rawUrl);
    if (walkUrl.protocol !== "http:" && walkUrl.protocol !== "https:") throw new Error("scheme");
  } catch {
    console.log("NABB_WALK_URL is not a URL");
    return 2;
  }
  const sessionFile = join(process.env.HOME || homedir(), ".studio", "walk-session");
  const session = readSession(sessionFile);
  if (!session) {
    console.log("session rejected");
    return 2;
  }
  mkdirSync(out, { recursive: true });
  try {
    unlinkSync(sessionFile);
  } catch {
    console.error("walk: the session file could not be removed");
    return 1;
  }

  const { results, dead } = await realWalk(shots, routes, out, only, walkUrl, session);
  if (dead) {
    console.log("session rejected");
    return 2;
  }
  writeReport(out, list.date, false, results, only);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // The kit's own words only: a raw error can embed a URL.
      console.error("walk: unexpected failure");
      process.exitCode = 1;
    },
  );
}
