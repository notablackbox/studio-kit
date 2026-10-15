import { before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines } from "./fixtures/film.ts";
import { boardDir, changedBoard } from "./fixtures/board.ts";

// film:edl: every shot resolved to its sources. A sung shot plays its clip's delivered take
// from `in = t0 - song_t0 + lag_s`, cut to the cover at the take's cut; a still or 2.5D shot is
// its plate; a clip with no delivered take falls back to the plate.

let dir = "";
before(() => {
  dir = boardDir();
});

const ARGS = (board: string, clips: string, out: string) => ["--board", board, "--clips", clips, "--words", "analysis/words.json", "--out", out];
const read = (out: string) => JSON.parse(readFileSync(join(dir, out, "edl.json"), "utf8"));
const report = (out: string) => JSON.parse(readFileSync(join(dir, out, "edl-report.json"), "utf8"));

function clipsCopy(name: string, change: (clips: string) => void): string {
  cpSync(join(dir, "clips"), join(dir, name), { recursive: true });
  change(join(dir, name));
  return name;
}

test("the fixture board: one sung shot cut to its cover, one sung shot straight, the rest plates", () => {
  const result = film("edl", dir, ARGS("shots.json", "clips", "edl"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(lines(result.stdout), ["edl: 5 shots, 2 from takes (3 segments), 3 from plates, 0 fallbacks"]);
  assert.deepEqual(read("edl"), {
    s001: { plate: "p-dawn" },
    // W01's take 2 (take 1 failed): in = 0.976 - 0.976 + 0.31; it diverges, so at its cut
    // (3.987) the cover W01-c1 takes over: in = 3.987 - 3.97 + 0.2.
    s002: {
      segs: [
        { t0: 0.976, clip: "W01-t2", in: 0.31 },
        { t0: 3.987, clip: "W01-c1-t1", in: 0.217 },
      ],
    },
    s003: { plate: "p-window" },
    // W02's take has no sync: lag 0.
    s004: { segs: [{ t0: 6.462, clip: "W02-t1", in: 0 }] },
    s005: { plate: "p-roof" },
  });
  const r = report("edl");
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, { board: join(dir, "shots.json"), clips: join(dir, "clips"), words: join(dir, "analysis/words.json") });
  assert.deepEqual(r.outputs, { edl: "edl.json", report: "edl-report.json" });
  assert.deepEqual(r.fallbacks, []);
  assert.deepEqual(r.missing, []);
  // Coverage of the sung words by synced spans, per sung shot.
  assert.ok(r.coverage.s002.share > 0.9 && r.coverage.s002.share <= 1, JSON.stringify(r.coverage.s002));
  assert.equal(r.coverage.s004.synced_s, 0);
  assert.ok(r.coverage.s004.sung_s > 2);
  assert.deepEqual(readdirSync(join(dir, "edl")).sort(), ["edl-report.json", "edl.json"]);
});

test("a clip with no delivered take, or no clip file, falls back to the plate with a note", () => {
  const clips = clipsCopy("clips-pending", (folder) => {
    const w02 = JSON.parse(readFileSync(join(folder, "W02.json"), "utf8"));
    w02.takes[0].status = "submitted";
    writeFileSync(join(folder, "W02.json"), JSON.stringify(w02));
    rmSync(join(folder, "W01-c1.json"));
  });
  const result = film("edl", dir, ARGS("shots.json", clips, "pending"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    "edl: 5 shots, 1 from takes (2 segments), 4 from plates, 2 fallbacks",
    'fallback: "s002" plays plate "p-street" from 3.987 s: clip "W01-c1" has no delivered take',
    'fallback: "s004" plays plate "p-roof" from 6.462 s: clip "W02" has no delivered take',
  ]);
  const edl = read("pending");
  assert.deepEqual(edl.s004, { plate: "p-roof" });
  // The cover's file is gone: after the cut the hole is filled from the plate.
  assert.deepEqual(edl.s002, { segs: [{ t0: 0.976, clip: "W01-t2", in: 0.31 }, { t0: 3.987, plate: "p-street" }] });
  assert.deepEqual(report("pending").fallbacks, [
    { shot: "s002", clip: "W01-c1", at: 3.987, fallback: "no take", plate: "p-street" },
    { shot: "s004", clip: "W02", at: 6.462, fallback: "no take", plate: "p-roof" },
  ]);
});

test("a shot with neither a take nor a plate fails: exit 3, one line each, the report written", () => {
  const board = changedBoard(dir, "noplate.json", (_b, shot) => {
    shot("s003").plate = null;
    Object.assign(shot("s004"), { plate: null, clip: "W09" });
  });
  const result = film("edl", dir, ARGS(board, "clips", "noplate"));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    'edl: "s003" has neither a take nor a plate',
    'edl: "s004" has neither a take nor a plate (clip "W09" has no delivered take)',
  ]);
  const r = report("noplate");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["s003", "s004"]);
  assert.equal(existsSync(join(dir, "noplate", "edl.json")), false);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "afile"), "x");
  const broken = clipsCopy("clips-broken", (folder) => writeFileSync(join(folder, "W02.json"), '{"id": "W02", "takes": "none"}'));
  const wrongId = clipsCopy("clips-wrong", (folder) => writeFileSync(join(folder, "W02.json"), readFileSync(join(folder, "W01.json"))));
  const bad = changedBoard(dir, "bad.json", (b) => {
    (b as unknown as Record<string, unknown>).extra = 1;
  });
  const cases: [string[], string][] = [
    [["--board", "shots.json", "--clips", "clips", "--out", "x"], "film:edl: --board, --clips, --words and --out are required"],
    [ARGS("shots.json", "nope", "x"), "--clips is not a folder"],
    [ARGS("nope.json", "clips", "x"), "--board cannot be read"],
    [ARGS(bad, "clips", "x"), '--board: the board has an unknown field "extra"'],
    [["--board", "shots.json", "--clips", "clips", "--words", "analysis/beats.json", "--out", "x"], "--words is not a words.json"],
    [ARGS("shots.json", broken, "x"), '--clips: "W02.json" is not a clip file'],
    [ARGS("shots.json", wrongId, "x"), '--clips: "W02.json" holds clip "W01"'],
    [ARGS("shots.json", "clips", "afile"), "--out is not a folder"],
  ];
  for (const [args, line] of cases) {
    const result = film("edl", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  // A folder where edl.json goes: the write fails.
  mkdirSync(join(dir, "y", "edl.json"), { recursive: true });
  const result = film("edl", dir, ARGS("shots.json", "clips", "y"));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:edl: unexpected failure"]);
});
