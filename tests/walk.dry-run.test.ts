import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

type Shot = Record<string, unknown>;

function shot(n: number, overrides: Shot = {}): Shot {
  return {
    n,
    surface: "Office",
    route: "/app/office",
    dwell: 3,
    clicks: [],
    caption: "The run now shows its receipt",
    ...overrides,
  };
}

function setup(shotlist: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-walk-"));
  const file = join(dir, "shotlist.json");
  writeFileSync(file, typeof shotlist === "string" ? shotlist : JSON.stringify(shotlist));
  return { dir, file };
}

function walk(args: string[], dir: string) {
  // No NABB_WALK_URL and an empty HOME: a mode that reads either would say so.
  const env = { ...process.env, INIT_CWD: dir, HOME: dir };
  delete env.NABB_WALK_URL;
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/walk.ts", ...args], {
    cwd: kitRoot,
    encoding: "utf8",
    env,
  });
  return { result, output: `${result.stdout}${result.stderr}` };
}

function dryRun(shotlist: unknown) {
  const { dir, file } = setup(shotlist);
  return walk(["--shotlist", file, "--dry-run"], dir);
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function probe(file: string): string {
  const out = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate",
      "-of", "csv=p=0",
      file,
    ],
    { encoding: "utf8" },
  );
  return out.stdout.trim();
}

test("a valid shot list prints shot list ok and exits 0", () => {
  const { result } = dryRun({ date: "2026-10-13", shots: [shot(1), shot(2, { route: "/app/jobs" })] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result.stdout), ["shot list ok: 2 shots"]);
});

test("a fallback route is accepted", () => {
  const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, { route: "/app/office/methodology" })] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shot list ok: 1 shots/);
});

test("a route not in routes.json is refused with exit 2 and named", () => {
  const { result, output } = dryRun({ date: "2026-10-13", shots: [shot(1, { route: "/app/nowhere" })] });
  assert.equal(result.status, 2);
  assert.match(output, /\/app\/nowhere/);
  assert.doesNotMatch(output, /shot list ok/);
});

test("an unlisted click is refused", () => {
  const { result, output } = dryRun({ date: "2026-10-13", shots: [shot(1, { clicks: ["button.delete-everything"] })] });
  assert.equal(result.status, 2);
  assert.match(output, /click/);
  assert.match(output, /button\.delete-everything/);
});

test("thirteen shots are refused, twelve are accepted", () => {
  const many = (count: number) => ({
    date: "2026-10-13",
    shots: Array.from({ length: count }, (_, i) => shot(i + 1)),
  });
  const thirteen = dryRun(many(13));
  assert.equal(thirteen.result.status, 2);
  assert.match(thirteen.output, /12/);
  const twelve = dryRun(many(12));
  assert.equal(twelve.result.status, 0, twelve.result.stderr);
});

test("no shots is refused", () => {
  const { result } = dryRun({ date: "2026-10-13", shots: [] });
  assert.equal(result.status, 2);
});

test("a repeated n is refused", () => {
  const { result, output } = dryRun({ date: "2026-10-13", shots: [shot(1), shot(1)] });
  assert.equal(result.status, 2);
  assert.match(output, /repeat/);
});

test("dwell outside 3 to 20 is refused, the edges are accepted", () => {
  for (const dwell of [2.9, 20.1]) {
    const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, { dwell })] });
    assert.equal(result.status, 2, `dwell ${dwell}`);
  }
  for (const dwell of [3, 20]) {
    const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, { dwell })] });
    assert.equal(result.status, 0, `dwell ${dwell}`);
  }
});

test("an empty caption and a caption over 60 characters are refused, 60 is accepted", () => {
  for (const caption of ["", "x".repeat(61)]) {
    const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, { caption })] });
    assert.equal(result.status, 2, `caption length ${caption.length}`);
  }
  const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, { caption: "x".repeat(60) })] });
  assert.equal(result.status, 0, result.stderr);
});

test("every problem gets its own line", () => {
  const { result } = dryRun({
    date: "2026-10-13",
    shots: [shot(1, { route: "/app/nowhere", dwell: 1 }), shot(2, { caption: "" })],
  });
  assert.equal(result.status, 2);
  assert.ok(lines(result.stdout).length >= 3, result.stdout);
});

test("an unreadable or malformed shot list is refused with exit 2", () => {
  const missing = walk(["--shotlist", "does-not-exist.json", "--dry-run"], tmpdir());
  assert.equal(missing.result.status, 2);
  const notJson = dryRun("{not json");
  assert.equal(notJson.result.status, 2);
  const notObject = dryRun("[]");
  assert.equal(notObject.result.status, 2);
});

test("missing --shotlist, or missing --out outside a dry run, exits 2", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  assert.equal(walk([], dir).result.status, 2);
  assert.equal(walk(["--shotlist", file], dir).result.status, 2);
});

test("validation runs before any mode: a bad list with --synthetic writes nothing", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1, { route: "/app/nowhere" })] });
  const out = join(dir, "out");
  const { result } = walk(["--shotlist", file, "--out", out, "--synthetic"], dir);
  assert.equal(result.status, 2);
  assert.equal(existsSync(out), false);
});

test("--dry-run with --synthetic is a dry run", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  const out = join(dir, "out");
  const { result } = walk(["--shotlist", file, "--out", out, "--dry-run", "--synthetic"], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shot list ok: 1 shots/);
  assert.equal(existsSync(out), false);
});

test("--synthetic writes one 1920x1080 30 fps webm per shot and a report, with no env and no session", () => {
  const { dir, file } = setup({
    date: "2026-10-13",
    shots: [shot(1), shot(2, { route: "/app/jobs", dwell: 4 })],
  });
  const out = join(dir, "out");
  const { result, output } = walk(["--shotlist", file, "--out", out, "--synthetic"], dir);
  assert.equal(result.status, 0, output);
  assert.deepEqual(readdirSync(out).sort(), ["shot-01.webm", "shot-02.webm", "walk-report.json"]);
  for (const name of ["shot-01.webm", "shot-02.webm"]) {
    assert.match(probe(join(out, name)), /^vp[89],1920,1080,30\/1$/);
  }
  const report = JSON.parse(readFileSync(join(out, "walk-report.json"), "utf8"));
  assert.equal(report.date, "2026-10-13");
  assert.equal(report.synthetic, true);
  assert.equal(report.recorded, 2);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.shots[1], {
    n: 2,
    surface: "Office",
    route: "/app/jobs",
    ok: true,
    file: "shot-02.webm",
    seconds: 4,
    status: "recorded",
    error: "",
    usedFallback: false,
  });
});

test("--only merges one shot, on its fallback, into the report already in --out", () => {
  const { dir, file } = setup({
    date: "2026-10-13",
    shots: [shot(1), shot(2, { route: "/app/jobs" }), shot(3, { route: "/app/home" })],
  });
  const out = join(dir, "out");
  assert.equal(walk(["--shotlist", file, "--out", out, "--synthetic"], dir).result.status, 0);
  const before = readFileSync(join(out, "shot-01.webm"));

  const again = walk(["--shotlist", file, "--out", out, "--synthetic", "--only", "2"], dir);
  assert.equal(again.result.status, 0, again.output);
  const report = JSON.parse(readFileSync(join(out, "walk-report.json"), "utf8"));
  assert.deepEqual(report.shots.map((s: Shot) => s.n), [1, 2, 3]);
  assert.equal(report.shots[1].route, "/app/campaigns");
  assert.equal(report.shots[1].usedFallback, true);
  assert.equal(report.shots[0].usedFallback, false);
  assert.equal(report.recorded, 3);
  assert.equal(report.failed, 0);
  assert.deepEqual(readFileSync(join(out, "shot-01.webm")), before);
});

test("--only with no report in --out writes a fresh report holding that one shot", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1), shot(2, { route: "/app/jobs" })] });
  const out = join(dir, "out");
  mkdirSync(out);
  const { result, output } = walk(["--shotlist", file, "--out", out, "--synthetic", "--only", "2"], dir);
  assert.equal(result.status, 0, output);
  assert.deepEqual(readdirSync(out).sort(), ["shot-02.webm", "walk-report.json"]);
  const report = JSON.parse(readFileSync(join(out, "walk-report.json"), "utf8"));
  assert.equal(report.date, "2026-10-13");
  assert.equal(report.shots.length, 1);
  assert.equal(report.recorded, 1);
});

test("--only naming a shot that is not in the list exits 2", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  const out = join(dir, "out");
  const { result } = walk(["--shotlist", file, "--out", out, "--synthetic", "--only", "9"], dir);
  assert.equal(result.status, 2);
  assert.equal(existsSync(out), false);
});

test("a real walk with NABB_WALK_URL unset prints the line and exits 2, writing nothing", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  const out = join(dir, "out");
  const { result } = walk(["--shotlist", file, "--out", out], dir);
  assert.equal(result.status, 2);
  assert.deepEqual(lines(result.stdout), ["NABB_WALK_URL is not set"]);
  assert.equal(existsSync(out), false);
});
