import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, song, tempDir, type Truth } from "./fixtures/film.ts";

// film:words on the synthetic song's vocal stem: every word's true start and end are known.

type Words = {
  words: { i: number; w: string; line: number; t0: number; t1: number; conf: number; src: string }[];
  lines: { line: number; text: string; t0: number; t1: number }[];
  gaps: { t0: number; t1: number; after_word: number | null }[];
};

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
});

const read = (out: string): Words => JSON.parse(readFileSync(join(out, "words.json"), "utf8"));
const within = (words: Words["words"], tolerance = 0.1) =>
  words.filter((w, i) => Math.abs(w.t0 - truth.words[i].start) <= tolerance && Math.abs(w.t1 - truth.words[i].end) <= tolerance).length;

test("at least 90 percent of words within 0.10 s of their true span, checked against the truth", () => {
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--display", "display.txt", "--expect", "truth.json", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const timed = read(join(dir, "a"));
  assert.deepEqual(timed.words.map((w) => w.w), truth.words.map((w) => w.word));
  assert.deepEqual(timed.words.map((w) => w.i), truth.words.map((w) => w.i));
  assert.deepEqual(timed.words.map((w) => w.line), truth.words.map((w) => w.line));
  const good = within(timed.words);
  assert.ok(good / timed.words.length >= 0.9, `${good} of ${timed.words.length} within 0.10 s`);
  for (const w of timed.words) {
    assert.ok(w.t1 > w.t0, `word ${w.i}`);
    assert.ok(w.conf >= 0 && w.conf <= 1);
    assert.ok(["w2v", "whisper", "interp"].includes(w.src));
  }
  for (let i = 1; i < timed.words.length; i++) assert.ok(timed.words[i].t0 >= timed.words[i - 1].t0, "in order");

  assert.deepEqual(timed.lines.map((l) => [l.line, l.text]), truth.lines.map((l, i) => [i, l.text]));
  for (const l of timed.lines) {
    const own = timed.words.filter((w) => w.line === l.line);
    assert.equal(l.t0, own[0].t0);
    assert.equal(l.t1, own.at(-1)!.t1);
  }
  assert.ok(Array.isArray(timed.gaps));
  for (const g of timed.gaps) assert.ok(g.t1 - g.t0 >= 2);

  const report = JSON.parse(readFileSync(join(dir, "a", "words-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, {
    vocals: join(dir, "vocals.wav"),
    lyrics: join(dir, "lyrics.txt"),
    display: join(dir, "display.txt"),
    expect: join(dir, "truth.json"),
    min_conf: 0.5,
  });
  assert.deepEqual(report.outputs, { words: "words.json", report: "words-report.json" });
  assert.equal(report.check.by, "expect");
  assert.equal(report.check.of, 12);
  assert.equal(report.check.within, good);
  assert.ok(Array.isArray(report.ear_check) && report.ear_check.length <= 5);
  assert.match(lines(result.stdout)[0], /^words: 12 words in 4 lines \(\d+ w2v, \d+ whisper, \d+ interp\), \d+ of 12 within 0\.10 s of the expected times$/);
});

test("without --expect the check is the aligner's own confidence", () => {
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "b"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "b", "words-report.json"), "utf8"));
  assert.equal(report.check.by, "conf");
  const timed = read(join(dir, "b"));
  assert.equal(report.check.within, timed.words.filter((w) => w.conf >= 0.5).length);
  assert.match(lines(result.stdout)[0], /, \d+ of 12 with confidence 0\.5 or more$/);
});

test("words under --min-conf fall back to faster-whisper, else to an even share of the gap", () => {
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "c", "--min-conf", "1"]);
  // Every word is below a confidence of 1, so the check fails: exit 3, the files still written.
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const timed = read(join(dir, "c"));
  const whisper = timed.words.filter((w) => w.src === "whisper");
  assert.ok(whisper.length >= 6, `whisper placed ${whisper.length} words`);
  // Whisper tiny's times are coarse (the wiki measures it 0.33 s early on average); refined on
  // the vocal energy, most land close.
  const close = whisper.filter((w) => Math.abs(w.t0 - truth.words[w.i].start) <= 0.15).length;
  assert.ok(close / whisper.length >= 0.7, `${close} of ${whisper.length} whisper words within 0.15 s`);
  for (const w of timed.words.filter((x) => x.src === "interp")) {
    const before = timed.words[w.i - 1];
    const after = timed.words[w.i + 1];
    assert.ok(before && after && before.line === w.line && after.line === w.line, `interp word ${w.i} sits between two words of its line`);
    assert.ok(w.t0 >= before.t1 - 1e-6 && w.t1 <= after.t0 + 1e-6);
  }
});

test("exit 3 when fewer than 90 percent are within 0.10 s; the report and words.json are written", () => {
  const shifted = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
  for (const w of shifted.words.slice(0, 4)) {
    w.start += 0.5;
    w.end += 0.5;
  }
  writeFileSync(join(dir, "shifted.json"), JSON.stringify(shifted));
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--expect", "shifted.json", "--out", "d"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const out = lines(result.stdout);
  assert.match(out[0], /^words: \d+ of 12 within 0\.10 s of the expected times, want at least 90 percent$/);
  for (const line of out.slice(1)) assert.match(line, /^word \d+ "[a-z]+": starts [-+]\d+\.\d\d s, ends [-+]\d+\.\d\d s off$/);
  assert.ok(out.length >= 5);
  const report = JSON.parse(readFileSync(join(dir, "d", "words-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.ok(existsSync(join(dir, "d", "words.json")));
});

test("exit 3 on a stem with no voice: the confidence check fails", () => {
  const result = film("words", dir, ["--vocals", "drums.wav", "--lyrics", "lyrics.txt", "--out", "e"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^words: \d+ of 12 with confidence 0\.5 or more, want at least 90 percent$/);
  const report = JSON.parse(readFileSync(join(dir, "e", "words-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.ok(report.ear_check.length >= 1 && report.ear_check.length <= 5);
});

test("the ear check lists at most five spots, most urgent first", () => {
  const sheet = tempDir("words-ear");
  // A line with no letters, and an all-caps token sung letter by letter.
  writeFileSync(join(sheet, "lyrics.txt"), "[Verse]\nthe city wakes\n...\nwe count the windows\n[Chorus]\nhold on\nhold the light\n");
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", join(sheet, "lyrics.txt"), "--out", "f"]);
  assert.ok(result.status === 0 || result.status === 3, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "f", "words-report.json"), "utf8"));
  assert.equal(report.ear_check[0].flag, "letters");
  assert.ok(report.ear_check.length <= 5);
  for (const spot of report.ear_check) assert.ok(["letters", "gap", "verylow", "lowconf", "length"].includes(spot.flag));
  assert.ok(lines(result.stdout).some((l) => /^ear check: line 1 has no letters$/.test(l)), result.stdout);
});

test("a display line that does not consume exactly its words is refused, naming the line", () => {
  writeFileSync(join(dir, "display-bad.txt"), "The city wakes.\nWe count|3 windows.\nHold on,\nhold the light.\n");
  const bad = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--display", "display-bad.txt", "--out", "x"]);
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.deepEqual(lines(bad.stdout), ['display line 2 ("We count|3 windows.") shows 5 words, its lyric line has 4']);
  assert.equal(existsSync(join(dir, "x")), false);

  writeFileSync(join(dir, "display-tokens.txt"), "The city wakes.\nWe|0 count|2 the|1 windows|1\nHOLD-ON|2\nhold the light.\n");
  const good = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--display", "display-tokens.txt", "--out", "g"]);
  assert.equal(good.status, 0, good.stdout + good.stderr);

  writeFileSync(join(dir, "display-short.txt"), "The city wakes.\n");
  const short = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--display", "display-short.txt", "--out", "x"]);
  assert.deepEqual(lines(short.stdout), ["--display has 1 lines, the lyric sheet 4"]);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "empty.txt"), "[Verse]\n\n");
  writeFileSync(join(dir, "noise.wav"), "not audio");
  const cases: [string[], string, NodeJS.ProcessEnv?][] = [
    [["--vocals", "vocals.wav", "--out", "x"], "film:words: --vocals <path>, --lyrics <path> and --out <dir> are required"],
    [["--vocals", "nope.wav", "--lyrics", "lyrics.txt", "--out", "x"], "--vocals cannot be read"],
    [["--vocals", "noise.wav", "--lyrics", "lyrics.txt", "--out", "x"], "--vocals cannot be read as audio"],
    [["--vocals", "vocals.wav", "--lyrics", "nope.txt", "--out", "x"], "--lyrics cannot be read"],
    [["--vocals", "vocals.wav", "--lyrics", "empty.txt", "--out", "x"], "the lyric sheet has no words to align"],
    [["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "x", "--min-conf", "2"], "--min-conf wants a number from 0 to 1"],
    [["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "x", "--expect", "lyrics.txt"], "--expect is not a words.json or a truth.json"],
    [["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "x"], 'model mms_fa is not in "/nowhere" (run python3 -I src/film/py/film_py/models.py --dest "/nowhere")', { FILM_MODELS: "/nowhere" }],
  ];
  for (const [args, line, env] of cases) {
    const result = film("words", dir, args, env);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("words", dir, ["--vocals", "vocals.wav", "--lyrics", "lyrics.txt", "--out", "y"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:words: python film_py.words failed"]);
});
