import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

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
  const sessionFile = join(home, ".studio", "walk-session");
  if (session !== undefined) {
    mkdirSync(join(home, ".studio"));
    writeFileSync(sessionFile, typeof session === "string" ? session : JSON.stringify(session));
  }
  const shotlist = join(home, "shotlist.json");
  writeFileSync(shotlist, JSON.stringify({ date: "2026-10-13", shots }));
  return { home, sessionFile, shotlist, out: join(home, "out") };
}

function shot(n: number, route: string) {
  return { n, surface: "Office", route, dwell: 3, clicks: [], caption: "A caption" };
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
    assert.deepEqual(report.shots[0], {
      n: 1,
      surface: "Office",
      route: "/app/office",
      ok: true,
      file: "shot-01.webm",
      seconds: 3,
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

test("a real --only records the fallback path, says so, and merges into the report", async () => {
  const token = randomUUID();
  const s = setup({ accessToken: token, expiresAt: future() }, [shot(1, "/app/office"), shot(2, "/app/office")]);
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
    const pages = server.seen.map((r) => r.path).filter((p) => p !== "/favicon.ico");
    assert.deepEqual(pages, ["/app/office/methodology"]);
    const report = JSON.parse(readFileSync(join(s.out, "walk-report.json"), "utf8"));
    assert.equal(report.shots.length, 1);
    assert.equal(report.shots[0].n, 2);
    assert.equal(report.shots[0].route, "/app/office/methodology");
    assert.equal(report.shots[0].usedFallback, true);
    assert.equal(report.shots[0].status, "recorded");
    assert.deepEqual(webms(s.out), ["shot-02.webm"]);
    assert.equal(run.output.includes(token), false);
  } finally {
    await server.close();
  }
});
