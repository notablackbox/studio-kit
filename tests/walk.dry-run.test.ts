import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSeconds } from "../src/walk.ts";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Shot = Record<string, unknown>;

const SURFACES: Record<string, string> = {
  "/app/office": "Office",
  "/app/office/methodology": "Office",
  "/app/jobs": "Hiring",
  "/app/campaigns": "Hiring",
  "/app/home": "Home",
  "/": "Home",
};

function shot(n: number, overrides: Shot = {}): Shot {
  const route = String(overrides.route ?? "/app/office");
  return {
    n,
    surface: SURFACES[route] ?? "Office",
    route,
    dwell: 3,
    clicks: [],
    caption: "The run now shows its receipt",
    ...overrides,
  };
}

function setup(shotlist: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-walk-"));
  temps.push(dir);
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

test("a date that is not a real YYYY-MM-DD is refused with one line, a real one is accepted", () => {
  for (const date of ["", "13 October 2026", "2026-13-01", "2026-02-30", "2026-10-13T00:00", 20261013]) {
    const { result } = dryRun({ date, shots: [shot(1)] });
    assert.equal(result.status, 2, `date ${JSON.stringify(date)}`);
    assert.deepEqual(lines(result.stdout), ["date must be a real date written YYYY-MM-DD"]);
  }
  const missing = dryRun({ shots: [shot(1)] });
  assert.equal(missing.result.status, 2);
  const leap = dryRun({ date: "2028-02-29", shots: [shot(1)] });
  assert.equal(leap.result.status, 0, leap.output);
});

test("a clip's seconds are rounded down to one decimal, never more than the file holds", () => {
  assert.equal(reportSeconds(3.033), 3);
  assert.equal(reportSeconds(3.08), 3);
  assert.equal(reportSeconds(2.999), 2.9);
  assert.equal(reportSeconds(8), 8);
  assert.equal(reportSeconds(8.1), 8.1);
  assert.equal(reportSeconds(2.3), 2.3);
  for (const measured of [0.3, 2.95, 3.0999, 14.96, 19.99, 20.04]) {
    const shown = reportSeconds(measured);
    assert.ok(shown <= measured && measured - shown < 0.1, `${measured} -> ${shown}`);
    assert.equal(shown, Number(shown.toFixed(1)));
  }
});

test("walk-report.json at a symlink is replaced, never written through, and never merged from", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1), shot(2, { route: "/app/jobs" })] });
  const out = join(dir, "out");
  mkdirSync(out);
  const outside = join(dir, "outside.json");
  const kept = JSON.stringify({ date: "2020-01-01", synthetic: true, shots: [{ n: 9 }], recorded: 1, failed: 0 });
  writeFileSync(outside, kept);
  symlinkSync(outside, join(out, "walk-report.json"));
  const run = walk(["--shotlist", file, "--out", out, "--synthetic", "--only", "2"], dir);
  assert.equal(run.result.status, 0, run.output);
  assert.equal(readFileSync(outside, "utf8"), kept, "the link's target was written through");
  assert.equal(lstatSync(join(out, "walk-report.json")).isFile(), true);
  const report = JSON.parse(readFileSync(join(out, "walk-report.json"), "utf8"));
  assert.deepEqual(report.shots.map((s: Shot) => s.n), [2], "a linked report is not merged");
  assert.equal(report.date, "2026-10-13");
  assert.deepEqual(readdirSync(out).filter((n) => n.endsWith(".tmp")), []);
});

test("--synthetic never writes a clip through a symlink at its name", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  const out = join(dir, "out");
  mkdirSync(out);
  const outside = join(dir, "outside");
  writeFileSync(outside, "keep me");
  symlinkSync(outside, join(out, "shot-01.webm"));
  const run = walk(["--shotlist", file, "--out", out, "--synthetic"], dir);
  assert.equal(run.result.status, 0, run.output);
  assert.equal(readFileSync(outside, "utf8"), "keep me", "the link's target was written through");
  assert.equal(lstatSync(join(out, "shot-01.webm")).isFile(), true);
  assert.deepEqual(readdirSync(out).sort(), ["shot-01.webm", "walk-report.json"]);
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
  const cases: [string[], string][] = [
    [[], "walk: --shotlist <path> is required"],
    [["--shotlist", file], "walk: --out <dir> is required unless --dry-run"],
    [["--shotlist", file, "--out", "out", "--only", "two"], "walk: --only wants a shot number"],
  ];
  for (const [args, line] of cases) {
    const { result } = walk(args, dir);
    assert.equal(result.status, 2, JSON.stringify(args));
    // Every refusal line is on stdout, in all three scripts.
    assert.deepEqual(lines(result.stdout), [line]);
  }
  const unknown = walk(["--nope"], dir);
  assert.equal(unknown.result.status, 2);
  assert.equal(lines(unknown.result.stdout).length, 1);
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
    surface: "Hiring",
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

test("npm run walk reaches the script: a dry run prints shot list ok", () => {
  const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
  const result = spawnSync("npm", ["run", "--silent", "walk", "--", "--shotlist", file, "--dry-run"], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shot list ok: 1 shots/);
});

test("a surface that is not the owning entry's surface is refused, naming the shot and both surfaces", () => {
  const { result } = dryRun({ date: "2026-10-13", shots: [shot(1), shot(2, { route: "/app/jobs", surface: "Office" })] });
  assert.equal(result.status, 2);
  const problems = lines(result.stdout);
  assert.equal(problems.length, 1, result.stdout);
  assert.match(problems[0], /shot 2/);
  assert.match(problems[0], /Office/);
  assert.match(problems[0], /Hiring/);
  const fallback = dryRun({ date: "2026-10-13", shots: [shot(1, { route: "/app/campaigns", surface: "Home" })] });
  assert.equal(fallback.result.status, 2, "a fallback route is held to its owner's surface too");
});

test("control characters in shot list values cannot forge a line: one problem is one line", () => {
  const forged = [
    { route: "/app/office\nshot list ok: 1 shots" },
    { route: "/app/office\r\nshot list ok: 1 shots" },
    { route: "/app/\u001b[2Joffice" },
    { route: "/app/\u009b2Joffice" },
    { surface: "Office\nshot list ok: 1 shots", route: "/app/jobs" },
    { clicks: ["a\nshot list ok: 1 shots"] },
  ];
  for (const overrides of forged) {
    const { result } = dryRun({ date: "2026-10-13", shots: [shot(1, overrides)] });
    assert.equal(result.status, 2, JSON.stringify(overrides));
    assert.equal(result.stdout.split("\n").filter((l) => l !== "").length, 1, JSON.stringify(result.stdout));
    assert.ok(result.stdout.endsWith("\n"));
    assert.doesNotMatch(result.stdout, /^shot list ok/m);
    assert.doesNotMatch(result.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, JSON.stringify(result.stdout));
  }
});

test("caption length counts code points: 31 and 60 astral characters pass, 61 are refused", () => {
  const astral = (count: number) => "\u{1F600}".repeat(count);
  assert.equal(astral(31).length, 62);
  const ok = dryRun({ date: "2026-10-13", shots: [shot(1, { caption: astral(31) })] });
  assert.equal(ok.result.status, 0, ok.output);
  const edge = dryRun({ date: "2026-10-13", shots: [shot(1, { caption: astral(60) })] });
  assert.equal(edge.result.status, 0, edge.output);
  const over = dryRun({ date: "2026-10-13", shots: [shot(1, { caption: astral(61) })] });
  assert.equal(over.result.status, 2);
});

test("--synthetic with a shot that names a fallback route directly sets usedFallback", () => {
  const { dir, file } = setup({
    date: "2026-10-13",
    shots: [shot(1, { route: "/app/office/methodology" }), shot(2, { route: "/app/jobs" })],
  });
  const out = join(dir, "out");
  const { result, output } = walk(["--shotlist", file, "--out", out, "--synthetic"], dir);
  assert.equal(result.status, 0, output);
  const report = JSON.parse(readFileSync(join(out, "walk-report.json"), "utf8"));
  assert.equal(report.shots[0].route, "/app/office/methodology");
  assert.equal(report.shots[0].usedFallback, true);
  assert.equal(report.shots[1].usedFallback, false);
});

test("NABB_WALK_URL that is not http or https is refused as not a URL, session file untouched", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp"]) {
    const { dir, file } = setup({ date: "2026-10-13", shots: [shot(1)] });
    mkdirSync(join(dir, ".studio"));
    const sessionFile = join(dir, ".studio", "walk-session");
    writeFileSync(sessionFile, JSON.stringify({ accessToken: "t", expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    const out = join(dir, "out");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/walk.ts", "--shotlist", file, "--out", out], {
      cwd: kitRoot,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: dir, HOME: dir, NABB_WALK_URL: url },
    });
    const all = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 2, `${url}: ${all}`);
    assert.deepEqual(lines(result.stdout), ["NABB_WALK_URL is not a URL"]);
    assert.equal(all.includes(url), false);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(existsSync(out), false);
  }
});
