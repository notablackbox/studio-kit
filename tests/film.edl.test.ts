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
  assert.deepEqual(lines(result.stdout), ["edl: 5 shots, 2 from takes (3 segments), 2 from plates, 1 from footage, 0 design, 0 fallbacks"]);
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
    // Genuine: the recorded footage, played like a clip.
    s003: { footage: "shot-01.webm" },
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
    "edl: 5 shots, 1 from takes (2 segments), 3 from plates, 1 from footage, 0 design, 2 fallbacks",
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

test("a still or 2.5D shot with no plate is pure motion design; a genuine shot without footage plays its plate", () => {
  const board = changedBoard(dir, "design.json", (_b, shot) => {
    shot("s001").plate = null;
    Object.assign(shot("s005"), { plate: null });
    shot("s003").footage = null;
  });
  const result = film("edl", dir, ARGS(board, "clips", "design"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["edl: 5 shots, 2 from takes (3 segments), 1 from plates, 0 from footage, 2 design, 0 fallbacks"]);
  const edl = read("design");
  assert.deepEqual(edl.s001, { design: true });
  assert.deepEqual(edl.s005, { design: true });
  assert.deepEqual(edl.s003, { plate: "p-window" });
});

test("a sung or motion shot with neither a take nor a plate fails: exit 3, one line each, the report written", () => {
  const board = changedBoard(dir, "noplate.json", (_b, shot) => {
    Object.assign(shot("s002"), { plate: null, clip: "W08", motion_tier: "motion" });
    Object.assign(shot("s004"), { plate: null, clip: "W09" });
  });
  const result = film("edl", dir, ARGS(board, "clips", "noplate"));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    'edl: "s002" has neither a take nor a plate (clip "W08" has no delivered take)',
    'edl: "s004" has neither a take nor a plate (clip "W09" has no delivered take)',
  ]);
  const r = report("noplate");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["s002", "s004"]);
  assert.equal(existsSync(join(dir, "noplate", "edl.json")), false);
});

test("a failing run after a good one in the same --out leaves no edl.json", () => {
  const good = film("edl", dir, ARGS("shots.json", "clips", "stale"));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.ok(existsSync(join(dir, "stale", "edl.json")));
  const board = changedBoard(dir, "stale-noplate.json", (_b, shot) => {
    Object.assign(shot("s004"), { plate: null, clip: "W09" });
  });
  const failed = film("edl", dir, ARGS(board, "clips", "stale"));
  assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  assert.equal(report("stale").ok, false);
  assert.deepEqual(readdirSync(join(dir, "stale")), ["edl-report.json"]);
});

test("footage must be a plain file name: a path is refused at the board read, exit 2", () => {
  for (const [n, footage] of ["../shot-01.webm", "footage/shot-01.webm", ".."].entries()) {
    const board = changedBoard(dir, `footage${n}.json`, (_b, shot) => {
      shot("s003").footage = footage;
    });
    const result = film("edl", dir, ARGS(board, "clips", `footage${n}`));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), [`--board: shots[2].footage is ${JSON.stringify(footage)}, want a plain file name (no slash, not . or ..) or null`]);
    assert.equal(existsSync(join(dir, `footage${n}`)), false);
  }
});

test("a delivered take with no file is no take; a take out of sync from its start falls back to the plate", () => {
  const clips = clipsCopy("clips-odd", (folder) => {
    const w02 = JSON.parse(readFileSync(join(folder, "W02.json"), "utf8"));
    delete w02.takes[0].file;
    writeFileSync(join(folder, "W02.json"), JSON.stringify(w02));
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.cut_at = 0.95;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
  });
  const result = film("edl", dir, ARGS("shots.json", clips, "odd"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    "edl: 5 shots, 0 from takes (0 segments), 4 from plates, 1 from footage, 0 design, 2 fallbacks",
    'fallback: "s002" plays plate "p-street" from 0.976 s: clip "W01" is out of sync from its start',
    'fallback: "s004" plays plate "p-roof" from 6.462 s: clip "W02" has no delivered take',
  ]);
  const edl = read("odd");
  assert.deepEqual(edl.s002, { plate: "p-street" });
  assert.deepEqual(edl.s004, { plate: "p-roof" });
  assert.deepEqual(report("odd").fallbacks, [
    { shot: "s002", clip: "W01", at: 0.976, fallback: "out of sync", plate: "p-street" },
    { shot: "s004", clip: "W02", at: 6.462, fallback: "no take", plate: "p-roof" },
  ]);
});

test("a take that starts late (a negative in) plays from its first frame after a head from the plate; one frame or less snaps; no plate fails", () => {
  // W01's song_t0 is the shot's start (0.976); sync measured the take 0.2 s late: in = 0 - 0.2 < 0.
  // The chapter engine would freeze the take's first frame for the difference, so the plate
  // fills the head and the take plays from frame 0 when it falls due (1.176); the cover is unchanged.
  const late = clipsCopy("clips-late", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.lag_s = -0.2;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
  });
  const result = film("edl", dir, ARGS("shots.json", late, "late"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    "edl: 5 shots, 2 from takes (4 segments), 2 from plates, 1 from footage, 0 design, 1 fallback",
    'fallback: "s002" plays plate "p-street" from 0.976 s: clip "W01" starts late (its take plays from its first frame when it falls due)',
  ]);
  assert.deepEqual(read("late").s002, {
    segs: [
      { t0: 0.976, plate: "p-street" },
      { t0: 1.176, clip: "W01-t2", in: 0 },
      { t0: 3.987, clip: "W01-c1-t1", in: 0.217 },
    ],
  });
  assert.deepEqual(report("late").fallbacks, [{ shot: "s002", clip: "W01", at: 0.976, fallback: "late start", plate: "p-street" }]);

  // One frame or less late (a lag one sync hop off): the take plays from its first frame, no fallback.
  const hop = clipsCopy("clips-hop", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.lag_s = -0.03;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
  });
  const snapped = film("edl", dir, ARGS("shots.json", hop, "hop"));
  assert.equal(snapped.status, 0, snapped.stdout + snapped.stderr);
  assert.deepEqual(lines(snapped.stdout), ["edl: 5 shots, 2 from takes (3 segments), 2 from plates, 1 from footage, 0 design, 0 fallbacks"]);
  assert.deepEqual(read("hop").s002.segs[0], { t0: 0.976, clip: "W01-t2", in: 0 });

  // A cover whose window starts after the cut: the cover's segment gets the same head from the plate.
  const covers = clipsCopy("clips-late-cover", (folder) => {
    const c1 = JSON.parse(readFileSync(join(folder, "W01-c1.json"), "utf8"));
    c1.song_t0 = 4.5;
    writeFileSync(join(folder, "W01-c1.json"), JSON.stringify(c1));
  });
  const cover = film("edl", dir, ARGS("shots.json", covers, "latecover"));
  assert.equal(cover.status, 0, cover.stdout + cover.stderr);
  assert.equal(lines(cover.stdout)[1], 'fallback: "s002" plays plate "p-street" from 3.987 s: clip "W01-c1" starts late (its take plays from its first frame when it falls due)');
  const segs = read("latecover").s002.segs;
  assert.deepEqual(segs[1], { t0: 3.987, plate: "p-street" });
  assert.equal(segs[2].clip, "W01-c1-t1");
  assert.equal(segs[2].in, 0);
  assert.equal(segs[2].t0, 4.3, JSON.stringify(segs));

  // No plate to fill the head from: the shot fails, exit 3, the report says why.
  const board = changedBoard(dir, "late-noplate.json", (_b, shot) => {
    shot("s002").plate = null;
  });
  const failed = film("edl", dir, ARGS(board, late, "late-noplate"));
  assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  const why = 'take "W01-t2" starts 0.200 s late (in = 0.976 - song_t0 0.976 + lag -0.200)';
  assert.deepEqual(lines(failed.stdout), [`edl: "s002" has neither a take nor a plate (${why})`]);
  const r = report("late-noplate");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["s002"]);
  assert.deepEqual(r.failures, [{ shot: "s002", why: `has neither a take nor a plate (${why})` }]);
  assert.equal(existsSync(join(dir, "late-noplate", "edl.json")), false);
});

test("a take whose first frame falls due at or after its cut never plays: the plate to the cut, then the cover, or the plate", () => {
  // W01's take is 1.5 s late (its first frame falls due at 2.476 s) and diverges 0.2 s into the
  // shot (cut at 1.176 s): none of it is in sync. The cover's window starts at 0.976 s, so at the
  // cut it plays from in = 1.176 - 0.976 + 0.2 = 0.4.
  const clips = clipsCopy("clips-latecut", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.lag_s = -1.5;
    w01.takes[1].sync.cut_at = 1.176;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
    const c1 = JSON.parse(readFileSync(join(folder, "W01-c1.json"), "utf8"));
    c1.song_t0 = 0.976;
    writeFileSync(join(folder, "W01-c1.json"), JSON.stringify(c1));
  });
  const result = film("edl", dir, ARGS("shots.json", clips, "latecut"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(read("latecut").s002, {
    segs: [
      { t0: 0.976, plate: "p-street" },
      { t0: 1.176, clip: "W01-c1-t1", in: 0.4 },
    ],
  });
  assert.deepEqual(lines(result.stdout).slice(1), ['fallback: "s002" plays plate "p-street" from 0.976 s: clip "W01" is out of sync from its start']);
  assert.deepEqual(report("latecut").fallbacks, [{ shot: "s002", clip: "W01", at: 0.976, fallback: "out of sync", plate: "p-street" }]);

  // No cover: the plate fills the whole shot from its start.
  const bare = clipsCopy("clips-latecut-bare", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.lag_s = -1.5;
    w01.takes[1].sync.cut_at = 1.176;
    w01.covers = [];
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
  });
  const plain = film("edl", dir, ARGS("shots.json", bare, "latecut-bare"));
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.deepEqual(read("latecut-bare").s002, { plate: "p-street" });
  assert.deepEqual(report("latecut-bare").fallbacks, [{ shot: "s002", clip: "W01", at: 0.976, fallback: "out of sync", plate: "p-street" }]);
});

test("a take is cut at its first divergence, even when the shot ends inside a later in-sync span", () => {
  // W01's take is in sync from 1.0 to 2.0 s, out of sync until 3.0 s, in sync again to 5.0 s;
  // its cut is 2.0. The shot ends at 4.5 s, inside the second span: the take still stops at 2.0
  // and the cover plays from there (its window starts at 1.9: in = 2.0 - 1.9 + 0.2).
  const clips = clipsCopy("clips-split", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.synced = [[1.0, 2.0], [3.0, 5.0]];
    w01.takes[1].sync.cut_at = 2.0;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
    const c1 = JSON.parse(readFileSync(join(folder, "W01-c1.json"), "utf8"));
    c1.song_t0 = 1.9;
    writeFileSync(join(folder, "W01-c1.json"), JSON.stringify(c1));
  });
  const board = changedBoard(dir, "split.json", (_b, shot) => {
    shot("s002").t1 = 4.5;
    shot("s003").t0 = 4.5;
  });
  const result = film("edl", dir, ARGS(board, clips, "split"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(read("split").s002, {
    segs: [
      { t0: 0.976, clip: "W01-t2", in: 0.31 },
      { t0: 2, clip: "W01-c1-t1", in: 0.3 },
    ],
  });
});

test("a cover chain past 16 takes is a hole where the last followed take diverges", () => {
  // W01 is cut at 1.0 s; each of 17 covers W01-c1 .. W01-c17 starts at the cut before it and is cut
  // 0.1 s later. The shot follows 16 takes (W01 and c1 .. c15); c15 diverges at 2.5 s, where the
  // chain would go on to c16: from there the plate plays, never c15 past its divergence.
  const clips = clipsCopy("clips-chain", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync = { lag_s: 0, synced: [], diverge_at: 1.0, cut_at: 1.0 };
    w01.covers = ["W01-c1"];
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
    const base = JSON.parse(readFileSync(join(folder, "W01-c1.json"), "utf8"));
    for (let n = 1; n <= 17; n++) {
      const start = Math.round((1.0 + 0.1 * (n - 1)) * 10) / 10;
      const cut = Math.round((start + 0.1) * 10) / 10;
      const cover = {
        ...base,
        id: `W01-c${n}`,
        song_t0: start,
        takes: [{ n: 1, status: "delivered", file: `clips/W01-c${n}/take-1.mp4`, sync: { lag_s: 0, synced: [], diverge_at: cut, cut_at: cut } }],
        covers: n < 17 ? [`W01-c${n + 1}`] : [],
      };
      writeFileSync(join(folder, `W01-c${n}.json`), JSON.stringify(cover));
    }
  });
  const result = film("edl", dir, ARGS("shots.json", clips, "chain"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const segs = read("chain").s002.segs;
  assert.equal(segs.length, 17, JSON.stringify(segs));
  assert.deepEqual(segs[0], { t0: 0.976, clip: "W01-t2", in: 0 });
  assert.deepEqual(segs[15], { t0: 2.4, clip: "W01-c15-t1", in: 0 });
  assert.deepEqual(segs[16], { t0: 2.5, plate: "p-street" });
  assert.ok(!segs.some((s: { clip?: string }) => s.clip === "W01-c16-t1"));
  assert.deepEqual(report("chain").fallbacks, [{ shot: "s002", clip: "W01-c16", at: 2.5, fallback: "chain too long", plate: "p-street" }]);
  assert.deepEqual(lines(result.stdout).slice(1), ['fallback: "s002" plays plate "p-street" from 2.500 s: clip "W01-c16" is past the cover chain\'s 16 takes']);
});

test("a divergence with no cut (before the first eighth) is out of sync from the shot's start: the plate, or exit 3", () => {
  // film:sync gives cut_at null when no eighth note is at or before the divergence.
  const clips = clipsCopy("clips-early", (folder) => {
    const w01 = JSON.parse(readFileSync(join(folder, "W01.json"), "utf8"));
    w01.takes[1].sync.diverge_at = 0.1;
    w01.takes[1].sync.cut_at = null;
    writeFileSync(join(folder, "W01.json"), JSON.stringify(w01));
  });
  const result = film("edl", dir, ARGS("shots.json", clips, "early"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(read("early").s002, { plate: "p-street" });
  assert.deepEqual(report("early").fallbacks, [{ shot: "s002", clip: "W01", at: 0.976, fallback: "out of sync", plate: "p-street" }]);
  assert.equal(lines(result.stdout)[1], 'fallback: "s002" plays plate "p-street" from 0.976 s: clip "W01" is out of sync from its start');
  // No plate: the shot fails.
  const board = changedBoard(dir, "early-noplate.json", (_b, shot) => {
    shot("s002").plate = null;
  });
  const failed = film("edl", dir, ARGS(board, clips, "early-noplate"));
  assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  assert.deepEqual(lines(failed.stdout), ['edl: "s002" has neither a take nor a plate (clip "W01" diverges at 0.100 s, before any cut)']);
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
