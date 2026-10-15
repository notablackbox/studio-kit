import { before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, tempDir } from "./fixtures/film.ts";
import { boardFixture } from "./fixtures/board.ts";
import { fakeVideo } from "./fixtures/chapter.ts";

// film:captions: one SRT cue per display line, markers stripped, timed from the line's first
// word to its last; with --video, the SRT burned in.

let dir = "";
before(() => {
  dir = tempDir("captions");
  cpSync(join(boardFixture, "analysis"), dir, { recursive: true });
});

test("an SRT with one cue per display line, and a captioned render", () => {
  writeFileSync(join(dir, "marked.txt"), "The *city* wakes.\nWe count|2 windows.\nHold on,\n~hold~ the light.\n");
  fakeVideo(join(dir, "clip.mp4"), 3, "testsrc2", "640x360");
  const result = film("captions", dir, ["--words", "words.json", "--display", "marked.txt", "--video", "clip.mp4", "--out", "cc"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["captions: 4 cues in captions.srt, burned into captioned.mp4"]);
  assert.equal(
    readFileSync(join(dir, "cc", "captions.srt"), "utf8"),
    [
      "1\n00:00:01,000 --> 00:00:02,525\nThe city wakes.\n",
      "2\n00:00:02,995 --> 00:00:05,345\nWe count windows.\n",
      "3\n00:00:06,960 --> 00:00:08,100\nHold on,\n",
      "4\n00:00:08,440 --> 00:00:10,080\nhold the light.\n",
    ].join("\n"),
  );
  assert.ok(existsSync(join(dir, "cc", "captioned.mp4")));
  const report = JSON.parse(readFileSync(join(dir, "cc", "captions-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.cues.length, 4);
  assert.deepEqual(report.outputs, { srt: "captions.srt", report: "captions-report.json", captioned: "captioned.mp4" });
  assert.equal(report.captioned.width, 640);
});

test("without --video, only the SRT", () => {
  const result = film("captions", dir, ["--words", "words.json", "--display", "display.txt", "--out", "srt"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(dir, "srt", "captioned.mp4")), false);
  assert.equal(readFileSync(join(dir, "srt", "captions.srt"), "utf8").split("-->").length - 1, 4);
});

test("refusals: missing flags, a display that does not fit words.json, a video that is not one", () => {
  writeFileSync(join(dir, "short.txt"), "The city wakes.\n");
  writeFileSync(join(dir, "fake.mp4"), "not a video");
  const cases: [string[], string[]][] = [
    [["--words", "words.json"], ["film:captions: --words, --display and --out are required"]],
    [["--words", "words.json", "--display", "short.txt", "--out", "x"], ["--display has 1 lyric line, words.json has 4"]],
    [["--words", "words.json", "--display", "display.txt", "--video", "fake.mp4", "--out", "x"], ["--video cannot be read as a video"]],
  ];
  for (const [args, want] of cases) {
    const result = film("captions", dir, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), want);
  }
  assert.equal(existsSync(join(dir, "x")), false);
});

test("a cue's times must be finite seconds from 0, ending no earlier than they start", () => {
  const data = JSON.parse(readFileSync(join(dir, "words.json"), "utf8"));
  const [w4, w7] = [data.words[4], data.words[7]];
  assert.deepEqual([w4.line, w7.line], [1, 2]);
  // Word 4 ends before it starts; word 7 ends at 1e309, which JSON reads as Infinity.
  w4.t1 = w4.t0 - 0.5;
  w7.t1 = 7777;
  writeFileSync(join(dir, "badtimes.json"), JSON.stringify(data).replace("7777", "1e309"));
  const result = film("captions", dir, ["--words", "badtimes.json", "--display", "display.txt", "--out", "bad"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), [
    `cue 1 ("We count the windows."): word 4 ends at ${w4.t1}, before its start at ${w4.t0}`,
    'cue 2 ("Hold on,"): word 7 t1 is Infinity, want finite seconds from 0',
  ]);
  assert.equal(existsSync(join(dir, "bad")), false);
});
