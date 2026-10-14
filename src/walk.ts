import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext } from "playwright";

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns the shot list when it is valid, else one problem per entry.
export function validateShotList(raw: unknown, routes: Route[]): { list?: ShotList; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { problems: ["shot list is not a JSON object"] };
  if (typeof raw.date !== "string" || raw.date === "") problems.push("date is missing");
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
    if (typeof entry.caption !== "string" || entry.caption === "" || entry.caption.length > 60) {
      problems.push(`${label}: caption must be 1 to 60 characters`);
    }

    let owner: Route | undefined;
    if (typeof entry.route !== "string") problems.push(`${label}: route is missing`);
    else {
      owner = ownerOf(routes, entry.route);
      if (!owner) problems.push(`${label}: route ${entry.route} is not in routes.json`);
    }

    if (!Array.isArray(entry.clicks) || entry.clicks.some((c) => typeof c !== "string")) {
      problems.push(`${label}: clicks must be a list of selectors`);
    } else if (owner) {
      for (const click of entry.clicks as string[]) {
        if (!owner.clicks.includes(click)) problems.push(`${label}: click ${click} is not listed for ${entry.route}`);
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

function result(shot: Shot, route: string, usedFallback: boolean, error: string): ShotResult {
  const ok = error === "";
  return {
    n: shot.n,
    surface: shot.surface,
    route,
    ok,
    file: ok ? clipName(shot.n) : "",
    seconds: ok ? shot.dwell : 0,
    status: ok ? "recorded" : "failed",
    error,
    usedFallback,
  };
}

function synthetic(shots: Shot[], routes: Route[], out: string, only: boolean): ShotResult[] {
  const results: ShotResult[] = [];
  for (const shot of shots) {
    const route = only ? ownerOf(routes, shot.route)!.fallback : shot.route;
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
      results.push(result(shot, route, only, "clip not written"));
    } else {
      results.push(result(shot, route, only, ""));
    }
  }
  return results;
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
      const route = only ? ownerOf(routes, shot.route)!.fallback : shot.route;
      // On a fallback page, settle on the entry whose route is that path, else body, and click nothing.
      const fallbackPage = only || !routes.some((r) => r.route === route);
      const settle = routes.find((r) => r.route === route)?.settle ?? "body";
      const clicks = fallbackPage ? [] : shot.clicks;
      const context = await newRecordingContext(browser, out);
      let videoPath = "";
      let error = "";
      let dead = false;
      try {
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
        const page = await context.newPage();
        const video = page.video();
        if (video) videoPath = await video.path();
        if (videoPath) written.push(videoPath);

        const target = new URL(route, walkUrl);
        if (target.origin !== walkUrl.origin) error = "route leaves the walk host";
        else {
          try {
            await page.goto(target.href, { waitUntil: "domcontentloaded" });
          } catch {
            error = "page did not load";
          }
        }
        if (error === "" && i === 0 && new URL(page.url()).pathname === "/login") dead = true;
        if (error === "" && !dead) {
          try {
            await page.waitForSelector(settle, { timeout: SETTLE_TIMEOUT_MS });
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
        if (error === "" && !dead) await page.waitForTimeout(shot.dwell * 1000);
      } catch {
        if (error === "") error = "shot failed";
      } finally {
        await context.close().catch(() => {});
      }

      if (dead) {
        for (const file of written) rmSync(file, { force: true });
        return { results, dead: true };
      }
      if (error === "" && videoPath) {
        try {
          renameSync(videoPath, join(out, clipName(shot.n)));
          written[written.indexOf(videoPath)] = join(out, clipName(shot.n));
        } catch {
          error = "clip not written";
        }
      } else if (error === "") {
        error = "clip not written";
      }
      if (error !== "") {
        if (videoPath) rmSync(videoPath, { force: true });
        rmSync(join(out, clipName(shot.n)), { force: true });
      }
      results.push(result(shot, route, only, error));
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
    console.error(`walk: ${(error as Error).message}`);
    return 2;
  }
  if (!values.shotlist) {
    console.error("walk: --shotlist <path> is required");
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  if (!dryRun && !values.out) {
    console.error("walk: --out <dir> is required unless --dry-run");
    return 2;
  }
  let onlyN: number | undefined;
  if (values.only !== undefined) {
    if (!/^[0-9]+$/.test(values.only)) {
      console.error("walk: --only wants a shot number");
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
