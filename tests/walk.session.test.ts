import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// Holds the settle selectors of /app/office and /app/jobs. It has no Home group,
// so a /app/home shot never settles.
const PAGE = '<!doctype html><title>t</title><main><h1>synthetic</h1><section aria-label="Jobs">jobs</section></main>';

type Seen = { path: string; cookie: string; sessionFileExisted: boolean };

async function startServer(sessionFile: string, opts: { loginRedirect?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push({
      path,
      cookie: String(req.headers.cookie ?? ""),
      sessionFileExisted: existsSync(sessionFile),
    });
    if (opts.loginRedirect && path !== "/login") {
      res.statusCode = 302;
      res.setHeader("location", "/login");
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((done) => server.close(done)),
  };
}

function setup(session: unknown, shots: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), "studio-kit-session-"));
  temps.push(home);
  const sessionFile = join(home, ".studio", "walk-session");
  if (session !== undefined) {
    mkdirSync(join(home, ".studio"));
    writeFileSync(sessionFile, typeof session === "string" ? session : JSON.stringify(session));
  }
  const shotlist = join(home, "shotlist.json");
  writeFileSync(shotlist, JSON.stringify({ date: "2026-10-13", shots }));
  return { home, sessionFile, shotlist, out: join(home, "out") };
}

const SURFACES: Record<string, string> = { "/app/jobs": "Hiring", "/app/home": "Home", "/": "Home", "/app/campaigns": "Hiring" };

function shot(n: number, route: string) {
  return { n, surface: SURFACES[route] ?? "Office", route, dwell: 3, clicks: [], caption: "A caption" };
}

function runWalk(home: string, shotlist: string, out: string, url?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, INIT_CWD: home };
  delete env.NABB_WALK_URL;
  if (url !== undefined) env.NABB_WALK_URL = url;
  return new Promise<{ status: number | null; output: string; stdout: string }>((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/walk.ts", "--shotlist", shotlist, "--out", out], {
      cwd: kitRoot,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, output: stdout + stderr, stdout }));
  });
}

function webms(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".webm")) : [];
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

test("with no session file: exit 2, session rejected, no webm", async () => {
  const s = setup(undefined, [shot(1, "/app/office")]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 2, run.output);
    assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["session rejected"]);
    assert.deepEqual(webms(s.out), []);
    assert.equal(existsSync(join(s.out, "walk-report.json")), false);
    assert.deepEqual(server.seen, []);
  } finally {
    await server.close();
  }
});

test("with expiresAt in the past: the same, and the file is left as it is", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: Math.floor(Date.now() / 1000) - 10 }, [shot(1, "/app/office")]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 2, run.output);
    assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["session rejected"]);
    assert.deepEqual(webms(s.out), []);
    assert.equal(run.output.includes(token), false);
    assert.equal(existsSync(s.sessionFile), true);
    assert.deepEqual(server.seen, []);
  } finally {
    await server.close();
  }
});

test("malformed sessions are rejected with exit 2", async () => {
  const bad: unknown[] = [
    "not json",
    "[]",
    "null",
    {},
    { accessToken: "", expiresAt: future() },
    { accessToken: 5, expiresAt: future() },
    { accessToken: randomUUID() },
    { accessToken: randomUUID(), expiresAt: "soon" },
  ];
  for (const session of bad) {
    const s = setup(session, [shot(1, "/app/office")]);
    const run = await runWalk(s.home, s.shotlist, s.out, "http://127.0.0.1:9");
    assert.equal(run.status, 2, `${JSON.stringify(session)}: ${run.output}`);
    assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["session rejected"]);
    assert.deepEqual(webms(s.out), []);
    assert.equal(existsSync(s.sessionFile), true, "a rejected session file is left as it is");
  }
});

test("a bad shot list exits 2 before the environment or session is read", async () => {
  const s = setup(undefined, [shot(1, "/app/nowhere")]);
  const run = await runWalk(s.home, s.shotlist, s.out);
  assert.equal(run.status, 2);
  assert.doesNotMatch(run.output, /NABB_WALK_URL|session rejected/);
});

test("a live session: both cookies reach the server, the file is gone first, the token is never output", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [
    shot(1, "/app/office"),
    shot(2, "/app/jobs"),
  ]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 0, run.output);

    assert.ok(server.seen.length > 0);
    assert.equal(server.seen[0].sessionFileExisted, false, "the file was still there at the first request");
    assert.equal(existsSync(s.sessionFile), false);
    const pageRequests = server.seen.filter((r) => r.path === "/app/office" || r.path === "/app/jobs");
    assert.equal(pageRequests.length, 2, "both shot pages were requested");
    for (const request of pageRequests) {
      assert.match(request.cookie, new RegExp(`(^|; )access_token=${token}(;|$)`));
      assert.match(request.cookie, new RegExp(`(^|; )refresh_token=${token}(;|$)`));
    }

    assert.deepEqual(webms(s.out).sort(), ["shot-01.webm", "shot-02.webm"], readFileSync(join(s.out, "walk-report.json"), "utf8"));
    const reportText = readFileSync(join(s.out, "walk-report.json"), "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.synthetic, false);
    assert.equal(report.recorded, 2);
    assert.equal(report.failed, 0);
    // seconds is the trimmed clip's measured length, to one decimal: the dwell, give or take.
    assert.ok(Math.abs(report.shots[0].seconds - 3) <= 0.2, `seconds ${report.shots[0].seconds}`);
    assert.deepEqual(report.shots[0], {
      n: 1,
      surface: "Office",
      route: "/app/office",
      ok: true,
      file: "shot-01.webm",
      seconds: report.shots[0].seconds,
      status: "recorded",
      error: "",
      usedFallback: false,
    });

    assert.equal(run.output.includes(token), false, "token in output");
    assert.equal(reportText.includes(token), false, "token in report");
    assert.equal(run.output.includes(server.url), false, "walk URL in output");
    assert.equal(reportText.includes(server.url), false, "walk URL in report");
    assert.equal(reportText.includes("127.0.0.1"), false);
  } finally {
    await server.close();
  }
});

test("a shot whose settle selector never appears is marked failed and the walk goes on", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [
    shot(1, "/app/home"),
    shot(2, "/app/office"),
  ]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 0, run.output);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.recorded, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.shots[0].ok, false);
    assert.equal(report.shots[0].status, "failed");
    assert.equal(report.shots[0].error, "settle selector not found");
    assert.equal(report.shots[1].ok, true);
    assert.deepEqual(webms(s.out), ["shot-02.webm"]);
    assert.equal(run.output.includes(token), false);
  } finally {
    await server.close();
  }
});

test("a first navigation that lands on /login: session rejected, exit 2, no clip, no report", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office"), shot(2, "/app/jobs")]);
  const server = await startServer(s.sessionFile, { loginRedirect: true });
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 2, run.output);
    assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["session rejected"]);
    assert.deepEqual(webms(s.out), []);
    assert.equal(existsSync(join(s.out, "walk-report.json")), false);
    assert.equal(run.output.includes(token), false);
  } finally {
    await server.close();
  }
});

test("a real --only records the fallback path, says so, and writes a fresh report", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/home"), shot(2, "/app/home")]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await new Promise<{ status: number | null; output: string }>((done) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home, INIT_CWD: s.home, NABB_WALK_URL: server.url };
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/walk.ts", "--shotlist", s.shotlist, "--out", s.out, "--only", "2"],
        { cwd: kitRoot, env },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      child.on("close", (status) => done({ status, output }));
    });
    assert.equal(run.status, 0, run.output);
    // Home's primary settle (the Focus or board view group) is not in the served page,
    // so only the fallback rule (body) lets this shot record.
    const pages = server.seen.map((r) => r.path).filter((p) => p !== "/favicon.ico");
    assert.deepEqual(pages, ["/"]);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots.length, 1);
    assert.equal(report.shots[0].n, 2);
    assert.equal(report.shots[0].route, "/");
    assert.equal(report.shots[0].usedFallback, true);
    assert.equal(report.shots[0].status, "recorded");
    assert.deepEqual(webms(s.out), ["shot-02.webm"]);
    assert.equal(run.output.includes(token), false);
  } finally {
    await server.close();
  }
});

test("a listed route that redirects to another origin: the other host is never asked, the shot fails, exit 0", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office"), shot(2, "/app/jobs")]);
  const other = await startServer(s.sessionFile);
  // The walk host sends /app/office to the other server: a different port is a different origin.
  const host = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/app/office") {
      res.statusCode = 302;
      res.setHeader("location", `${other.url}/landed`);
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
  const hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, hostUrl);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(other.seen, [], "the other origin received a request");
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].status, "failed");
    assert.equal(report.shots[0].error, "route leaves the walk host");
    assert.equal(report.shots[1].status, "recorded");
    assert.deepEqual(webms(s.out), ["shot-02.webm"]);
    assert.equal(run.output.includes(token), false);
    assert.equal(run.output.includes(other.url), false);
  } finally {
    await new Promise((done) => host.close(done));
    await other.close();
  }
});

// A walk host whose pages are PAGE, with per-path overrides.
async function startHost(handle: (path: string, res: import("node:http").ServerResponse) => boolean) {
  const seen: string[] = [];
  const host = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push(path);
    if (handle(path, res)) return;
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(host.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((done) => host.close(done)),
  };
}

test("a popup opened to another origin: the other host is never asked, the shot fails, no popup video is left", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office"), shot(2, "/app/jobs")]);
  const other = await startServer(s.sessionFile);
  const host = await startHost((path, res) => {
    if (path !== "/app/office") return false;
    res.setHeader("content-type", "text/html");
    res.end(
      PAGE +
        `<a id="out" href="${other.url}/anchor" target="_blank">out</a>` +
        `<script>window.open(${JSON.stringify(`${other.url}/x`)}); document.getElementById("out").click();</script>`,
    );
    return true;
  });
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, host.url);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(other.seen, [], "the other origin received a request");
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].status, "failed");
    assert.equal(report.shots[0].error, "route leaves the walk host");
    assert.equal(report.shots[1].status, "recorded");
    assert.deepEqual(readdirSync(s.out).sort(), ["shot-02.webm", "walk-report.json"]);
    assert.equal(run.output.includes(token), false);
    assert.equal(run.output.includes(other.url), false);
  } finally {
    await host.close();
    await other.close();
  }
});

test("a later shot that lands on /login: session rejected, exit 2, every clip of the run removed, no report", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office"), shot(2, "/app/jobs")]);
  const host = await startHost((path, res) => {
    if (path !== "/app/jobs") return false;
    res.statusCode = 302;
    res.setHeader("location", "/login");
    res.end();
    return true;
  });
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, host.url);
    assert.equal(run.status, 2, run.output);
    assert.ok(host.seen.includes("/app/office") && host.seen.includes("/login"), host.seen.join(","));
    assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["session rejected"]);
    assert.deepEqual(webms(s.out), []);
    assert.equal(existsSync(join(s.out, "walk-report.json")), false);
    assert.equal(run.output.includes(token), false);
  } finally {
    await host.close();
  }
});

test("a page that answers 404 fails the shot with page answered 404, its clip removed, the walk goes on", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/jobs"), shot(2, "/app/office")]);
  const host = await startHost((path, res) => {
    if (path !== "/app/jobs") return false;
    // The body still holds the settle selector: only the status can fail the shot.
    res.statusCode = 404;
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
    return true;
  });
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, host.url);
    assert.equal(run.status, 0, run.output);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].status, "failed");
    assert.equal(report.shots[0].error, "page answered 404");
    assert.equal(report.shots[0].file, "");
    assert.equal(report.shots[1].status, "recorded");
    assert.deepEqual(readdirSync(s.out).sort(), ["shot-02.webm", "walk-report.json"]);
  } finally {
    await host.close();
  }
});

function ffprobe(file: string) {
  const out = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  const stream = parsed.streams[0];
  return {
    codec: stream.codec_name as string,
    width: stream.width as number,
    height: stream.height as number,
    rate: stream.r_frame_rate as string,
    duration: Number(parsed.format.duration),
  };
}

// The centre pixel of a clip's first frame, as [r, g, b].
function firstFrameCentre(file: string): number[] {
  const out = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "crop=2:2:959:539", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1024 * 1024 },
  );
  assert.equal(out.status, 0, String(out.stderr));
  return [...out.stdout.subarray(0, 3)];
}

test("a real clip starts on the settled page and runs the dwell; seconds is the clip's measured length", async (t) => {
  const token = randomUUID();
  const dwell = 3;
  const s = setup({ accessToken: token, expiresAt: future() }, [{ ...shot(1, "/app/office"), dwell }]);
  // A blank white page for about 2 s, then a solid green page holding the settle element.
  const slow =
    '<!doctype html><title>t</title><body style="margin:0;background:#ffffff"></body><script>' +
    "setTimeout(() => { document.body.style.background = '#00c000';" +
    " const m = document.createElement('main'); m.style.height = '100vh'; document.body.append(m); }, 2000);" +
    "</script>";
  const host = await startHost((path, res) => {
    if (path !== "/app/office") return false;
    res.setHeader("content-type", "text/html");
    res.end(slow);
    return true;
  });
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, host.url);
    assert.equal(run.status, 0, run.output);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].status, "recorded", JSON.stringify(report.shots[0]));
    const clip = join(s.out, "shot-01.webm");
    const p = ffprobe(clip);
    assert.match(p.codec, /^vp[89]$/);
    assert.equal(p.width, 1920);
    assert.equal(p.height, 1080);
    assert.equal(p.rate, "30/1");
    // No clicks on this route: the clip is the dwell.
    assert.ok(Math.abs(p.duration - dwell) <= 0.4, `clip runs ${p.duration} s, dwell ${dwell} s`);
    // Rounded down to one decimal: never more than the file holds, less by under 0.1 s.
    const s0 = report.shots[0].seconds;
    assert.ok(s0 <= p.duration && p.duration - s0 < 0.1, `seconds ${s0}, file ${p.duration}`);
    assert.equal(report.shots[0].seconds, Math.round(report.shots[0].seconds * 10) / 10, "one decimal");
    const [r, g, b] = firstFrameCentre(clip);
    t.diagnostic(`clip ${p.duration} s, seconds ${report.shots[0].seconds}, first frame centre rgb(${r}, ${g}, ${b})`);
    assert.ok(g > 120 && r < 100 && b < 100, `first frame centre is rgb(${r}, ${g}, ${b}), not the settled green`);
    assert.deepEqual(readdirSync(s.out).sort(), ["shot-01.webm", "walk-report.json"], "no raw or part-trimmed video left");
    assert.equal(run.output.includes(token), false);
  } finally {
    await host.close();
  }
});

test("symlinks in --out at the clip's name or a trim name are never written through", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office")]);
  mkdirSync(s.out);
  const targets: string[] = [];
  // The old predictable trim name, and the clip's own name, each a link to a file outside --out.
  for (const name of [".shot-01.webm.trim", "shot-01.webm"]) {
    const target = join(s.home, `outside-${targets.length}`);
    writeFileSync(target, "keep me");
    symlinkSync(target, join(s.out, name));
    targets.push(target);
  }
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 0, run.output);
    for (const target of targets) assert.equal(readFileSync(target, "utf8"), "keep me", `${target} was written through`);
    assert.equal(lstatSync(join(s.out, "shot-01.webm")).isFile(), true);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].status, "recorded", JSON.stringify(report.shots[0]));
    assert.deepEqual(readdirSync(s.out).filter((n) => n.endsWith(".trim.webm")), [], "no trim file left");
  } finally {
    await server.close();
  }
});

test("a shot that names a fallback route directly sets usedFallback and reports the path opened", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/"), shot(2, "/app/office")]);
  const server = await startServer(s.sessionFile);
  try {
    const run = await runWalk(s.home, s.shotlist, s.out, server.url);
    assert.equal(run.status, 0, run.output);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots[0].route, "/");
    assert.equal(report.shots[0].usedFallback, true);
    assert.equal(report.shots[0].status, "recorded");
    assert.equal(report.shots[1].usedFallback, false);
  } finally {
    await server.close();
  }
});
