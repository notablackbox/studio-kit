import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines } from "./fixtures/film.ts";
import { CHAPTER_BOARD, chapterProject, readJson, type ChapterProject } from "./fixtures/chapter.ts";
import { holdHeavy } from "./fixtures/heavy.ts";

// The chapter engine end to end, in Remotion over headless Chromium: a ten-second chapter of
// the synthetic song (a still plate, a sung shot on a fake take with two devices, a line across
// a cut, genuine footage, a 2.5D shot entering on a dither, a design shot with a masthead, the
// chrome) rendered, gated N/N, flash-clean and history-independent across a cut; a board built
// to flash fails the flash check; the 9:16 reframe keeps the gate; refusals before any work.
// All renders of this file run one after another (one browser at a time), and never beside the
// Teaser's full render in render.test.ts (the heavy lock, held for the whole file).

let p: ChapterProject;
let rendered: { status: number | null; stdout: string; stderr: string };
const seconds: Record<string, number> = {};
const timed = <T>(name: string, body: () => T): T => {
  const start = Date.now();
  const result = body();
  seconds[name] = Math.round((Date.now() - start) / 100) / 10;
  console.log(`# ${name}: ${seconds[name]} s`);
  return result;
};

let releaseHeavy = () => {};

before(() => {
  releaseHeavy = holdHeavy();
  p = chapterProject();
  rendered = timed("film:chapter, ten seconds", () => film("chapter", p.dir, p.args("ch")));
});

after(() => releaseHeavy());

test("a ten-second chapter renders straight to video, with its tokens sidecar, sound events and report", () => {
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  assert.equal(rendered.stderr, "");
  assert.match(lines(rendered.stdout)[0], /^chapter: "ch01" 240 frames \(10\.000 s, 1920x1080, 24 fps, \d+ bytes\), 12 sung words drawn, 3 sound events$/);
  assert.deepEqual(readdirSync(join(p.dir, "ch")).sort(), ["ch01.audio.json", "ch01.mp4", "ch01.tokens.json", "chapter-report.json"]);
  const report = readJson(join(p.dir, "ch", "chapter-report.json"));
  assert.equal(report.ok, true);
  assert.equal(report.ramp, true);
  assert.equal(report.video.width, 1920);
  assert.equal(report.video.height, 1080);
  assert.equal(report.video.fps, 24);
  assert.ok(Math.abs(report.video.duration - 10) < 0.05, String(report.video.duration));
  assert.ok(report.video.size > 100_000);
  assert.equal(report.video.color_primaries, "bt709");
  assert.deepEqual(report.shots, ["s001", "s002", "s003", "s004", "s005", "s006"]);
  assert.equal(report.inputs.chapter, "ch01");
  assert.equal(report.inputs.board, join(p.dir, "board", "shots.json"));
  const sidecar = readJson(join(p.dir, "ch", "ch01.tokens.json"));
  assert.equal(sidecar.fps, 24);
  assert.equal(sidecar.ramp, true);
  assert.equal(sidecar.frames.length, 240);
  assert.deepEqual(sidecar.frames[24], { t: 1, tokens: [{ word: 0, text: "The" }] });
  assert.deepEqual(readJson(join(p.dir, "ch", "ch01.audio.json")).map((e: { t: number; kind: string }) => [e.t, e.kind]), [[1, "stamp"], [3, "tick"], [6.5, "whoosh"]]);
});

test("the chapter's lyric gate: N/N", () => {
  const result = film("gate", p.dir, ["--tokens", "ch/ch01.tokens.json", "--words", "analysis/words.json", "--display", "analysis/display.txt", "--out", "gate"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["gate: 12/12"]);
});

test("the chapter is flash-clean", () => {
  const result = timed("film:flash, ten seconds", () => film("flash", p.dir, ["--video", "ch/ch01.mp4", "--out", "flash"]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^flash: clean, 240 frames/);
});

test("history-independent across a cut: frame 60 (the take) alone and after frame 190 (2.5D)", () => {
  const result = timed("film:history", () => film("history", p.dir, [...p.args("history"), "--frames", "190,60"]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(result.stdout)[0], "HISTORY-INDEPENDENT");
  const report = readJson(join(p.dir, "history", "history-report.json"));
  assert.equal(report.ok, true);
  assert.ok(report.max_difference <= 40);
  assert.deepEqual(readdirSync(join(p.dir, "history")).sort(), ["history-190-then-60.png", "history-60.png", "history-report.json"]);
});

test("the 9:16 reframe of a range: 1080x1920, and its own sidecar passes the gate", () => {
  const result = timed("film:reframe, 2.2 seconds", () => film("reframe", p.dir, [...p.args("vertical"), "--range", "0.9:3.1"]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^reframe: "ch01" 53 frames \(2\.208 s, 1080x1920, 24 fps, \d+ bytes\)/);
  assert.deepEqual(readdirSync(join(p.dir, "vertical")).sort(), ["ch01.9x16.audio.json", "ch01.9x16.mp4", "ch01.9x16.tokens.json", "reframe-report.json"]);
  const gate = film("gate", p.dir, ["--tokens", "vertical/ch01.9x16.tokens.json", "--words", "analysis/words.json", "--display", "analysis/display.txt", "--out", "vgate"]);
  assert.equal(gate.status, 0, gate.stdout);
  assert.deepEqual(lines(gate.stdout), ["gate: 4/4"]);
  const report = readJson(join(p.dir, "vertical", "reframe-report.json"));
  assert.deepEqual([report.video.width, report.video.height], [1080, 1920]);
  assert.deepEqual(report.rendered.t0, 0.9167);
});

test("a board built to flash (four masthead swaps a second, ramps off) fails the flash check", () => {
  // Alternating three-frame shots: a bright plate, then a masthead card on black, from 0 to 2 s.
  const board = structuredClone(CHAPTER_BOARD) as Record<string, unknown> & { shots: Record<string, unknown>[]; chapters: Record<string, unknown>[] };
  board.chapters = [{ id: "fl", name: "Flash", t0: 0, t1: 2, sections: ["Verse"] }, { id: "rest", name: "Rest", t0: 2, t1: 12, sections: ["Verse"] }];
  board.shots = Array.from({ length: 17 }, (_, k) => {
    const card = k % 2 === 1 && k < 16;
    const t0 = k * 0.125;
    return {
      id: `s${String(k + 1).padStart(3, "0")}`, t0, t1: k < 16 ? t0 + 0.125 : 12, section: "Verse", lines: [], set: "sky", lead_on_screen: false, framing: card ? null : "EWS",
      action: "swap", camera: "locked", motion_tier: "still", plate: card ? null : "p-white", clip: null, prompt: "",
      type: card ? [{ line: null, mode: "masthead", text: "NOW", placement: "centre" }] : [], devices: [], treatment: null, transition_in: "cut", chrome: "off", notes: "",
    };
  });
  board.plates = [{ plate: "p-white", set: "sky", prompt: "sky", aspect: "16:9", used_by: [] }];
  const f = chapterProject(board);
  const args = [...f.args("ch").map((a) => (a === "ch01" ? "fl" : a)), "--range", "0:1.5", "--no-ramp"];
  // --no-ramp is test-only: refused without FILM_TEST=1.
  const refused = film("chapter", f.dir, args);
  assert.equal(refused.status, 2);
  assert.deepEqual(lines(refused.stdout), ["--no-ramp is for the kit's tests only (FILM_TEST=1)"]);
  const made = timed("film:chapter --no-ramp, 1.5 seconds", () => film("chapter", f.dir, args, { FILM_TEST: "1" }));
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.equal(readJson(join(f.dir, "ch", "chapter-report.json")).ramp, false);
  assert.equal(readJson(join(f.dir, "ch", "fl.tokens.json")).ramp, false);
  const result = film("flash", f.dir, ["--video", "ch/fl.mp4", "--out", "flash"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^flash: [4-9] flashes in one second between /);
  assert.equal(readJson(join(f.dir, "flash", "flash-report.json")).ok, false);
});

test("the history check fails (exit 3) on a frame that depends on the one before: the test-only probe", () => {
  const refused = film("history", p.dir, [...p.args("leak"), "--frames", "190,60", "--test-leak"]);
  assert.equal(refused.status, 2);
  assert.deepEqual(lines(refused.stdout), ["--test-leak is for the kit's tests only (FILM_TEST=1)"]);
  const result = timed("film:history --test-leak", () => film("history", p.dir, [...p.args("leak"), "--frames", "190,60", "--test-leak"], { FILM_TEST: "1" }));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^history: frame 60 differs by \d+ levels at \d+,\d+ after frame 190 \(\d+ channels over 40\)$/);
  const report = readJson(join(p.dir, "leak", "history-report.json"));
  assert.equal(report.ok, false);
  assert.ok(report.max_difference > 40);
  // The probe's square is the top-left corner.
  assert.ok(report.at.x < 96 && report.at.y < 96, JSON.stringify(report.at));
});

test("refusals before any work: flags, chapter, range, a missing take, footage outside its folder, mattes, typed words", () => {
  const edl = readJson(join(p.dir, "edit", "edl.json"));
  writeFileSync(join(p.dir, "edit", "escape.json"), JSON.stringify({ ...edl, s004: { footage: "../board/shots.json" } }));
  writeFileSync(join(p.dir, "edit", "badplate.json"), JSON.stringify({ ...edl, s001: { plate: "../board/shots" } }));
  writeFileSync(join(p.dir, "edit", "badtake.json"), JSON.stringify({ ...edl, s002: { segs: [{ t0: 0.976, clip: "../W01-t2", in: 0.31 }] } }));
  const wide = structuredClone(CHAPTER_BOARD);
  const long = "The city WAKES-AND-EVERY-SINGLE-WINDOW-ON-THE-BLOCK-IS-LIT-UP";
  wide.shots[1].type[0] = { line: 0, mode: "coverline", text: long, placement: "left" };
  writeFileSync(join(p.dir, "board", "wide.json"), JSON.stringify(wide));
  // A plan refusal quoting text with a C1 control (U+0085, which JSON leaves raw): escaped.
  const control = structuredClone(CHAPTER_BOARD);
  control.shots[1].type[0] = { line: 0, mode: "coverline", text: long.replace("EVERY-", "EVERY\u0085"), placement: "left" };
  writeFileSync(join(p.dir, "board", "control.json"), JSON.stringify(control));
  mkdirSync(join(p.dir, "bare-plates"), { recursive: true });
  for (const f of readdirSync(join(p.dir, "plates")).filter((f) => !f.includes(".near.") && !f.includes(".mid.") && !f.includes(".far."))) cpSync(join(p.dir, "plates", f), join(p.dir, "bare-plates", f));
  mkdirSync(join(p.dir, "no-takes"), { recursive: true });
  const typed = structuredClone(CHAPTER_BOARD);
  typed.shots[1].type[1].text = "We count windows.";
  writeFileSync(join(p.dir, "board", "typed.json"), JSON.stringify(typed));
  // A chapter id names the outputs (<chapter>.mp4): one that is not a plain key, or one used
  // twice, is refused at the board. The sentinel sits where "../master" would write.
  const escape = structuredClone(CHAPTER_BOARD);
  escape.chapters[0].id = "../master";
  writeFileSync(join(p.dir, "board", "escape.json"), JSON.stringify(escape));
  const twice = structuredClone(CHAPTER_BOARD);
  twice.chapters[1].id = "ch01";
  writeFileSync(join(p.dir, "board", "twice.json"), JSON.stringify(twice));
  writeFileSync(join(p.dir, "master.mp4"), "sentinel");
  const swap = (args: string[], flag: string, value: string) => args.map((a, k) => (args[k - 1] === flag ? value : a));
  const base = p.args("x");
  const cases: [string[], string[]][] = [
    [["--board", "board/shots.json"], ["film:chapter: --board, --edl, --words, --beats, --hits, --display, --plates, --clips, --chapter, --out are required (missing --edl, --words, --beats, --hits, --display, --plates, --clips, --chapter, --out)"]],
    [swap(base, "--chapter", "ch09"), ['--chapter: the board has no chapter "ch09"']],
    [[...base, "--range", "9:12"], ['--range "9:12" is not inside chapter "ch01" (0 to 10 s)']],
    [[...base, "--range", "soon"], ['--range is "soon", want t0:t1 in song seconds (t0 before t1)']],
    [swap(base, "--clips", "no-takes"), ['--clips: "s002" plays take "W01-t2", which is not in the clips folder']],
    [swap(base, "--edl", "edit/escape.json"), ['--footage: "s004" footage "../board/shots.json" is outside the footage folder']],
    [swap(base, "--edl", "edit/badplate.json"), ['--edl: "s001" names plate "../board/shots", which is not a plate key']],
    [swap(base, "--edl", "edit/badtake.json"), ['--edl: "s002" names take "../W01-t2", which is not <clip>-t<n>']],
    [swap(base, "--board", "board/wide.json"), [`--board: "s002" type[0] coverline "${long}" does not fit one line at 56 px (16:9)`]],
    [swap(base, "--board", "board/control.json"), [`--board: "s002" type[0] coverline "${long.replace("EVERY-", "EVERY\\u0085")}" does not fit one line at 56 px (16:9)`]],
    [swap(base, "--plates", "bare-plates"), ['--plates: "s005" is plate3d and plate "p-roof" has no near, mid and far mattes']],
    [swap(base, "--board", "board/typed.json"), ['--board: "s002" type[1] shows 3 sung words, line 1 has 4 in words.json']],
    [swap(swap(base, "--board", "board/escape.json"), "--chapter", "../master"), ['--board: chapters[0].id is "../master", want a key of letters, digits, dot, dash or underscore']],
    [swap(base, "--board", "board/twice.json"), ['--board: chapters[1].id "ch01" is used twice']],
  ];
  for (const [args, want] of cases) {
    const result = film("chapter", p.dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), want);
    assert.equal(result.stderr, "");
  }
  assert.equal(existsSync(join(p.dir, "x")), false);
  assert.equal(readFileSync(join(p.dir, "master.mp4"), "utf8"), "sentinel");
});

test("a failing render after a good one in the same --out leaves none of the three outputs", () => {
  const good = film("chapter", p.dir, [...p.args("rerun"), "--range", "0:0.2"]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const outputs = ["ch01.mp4", "ch01.tokens.json", "ch01.audio.json"];
  for (const f of outputs) assert.ok(existsSync(join(p.dir, "rerun", f)), f);
  // The still plate the range shows is not an image: the browser cannot draw it, the render fails.
  cpSync(join(p.dir, "plates"), join(p.dir, "junk-plates"), { recursive: true });
  writeFileSync(join(p.dir, "junk-plates", "p-dawn.png"), "not a picture");
  const args = p.args("rerun", ["--range", "0:0.2"]).map((a, k, all) => (all[k - 1] === "--plates" ? "junk-plates" : a));
  const failed = film("chapter", p.dir, args);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.stdout, "");
  for (const f of outputs) assert.equal(existsSync(join(p.dir, "rerun", f)), false, `${f} is left from the good run`);
});

test("a render that cannot be written exits 1 with one line on stderr", () => {
  mkdirSync(join(p.dir, "blocked", "ch01.mp4"), { recursive: true });
  writeFileSync(join(p.dir, "blocked", "ch01.mp4", "keep"), "");
  const result = film("chapter", p.dir, [...p.args("blocked"), "--range", "1:1.2"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(lines(result.stderr).length, 1);
  assert.match(result.stderr, /^film:chapter: /);
  rmSync(join(p.dir, "blocked"), { recursive: true, force: true });
});
