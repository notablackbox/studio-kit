import { before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, tempDir } from "./fixtures/film.ts";
import { boardFixture } from "./fixtures/board.ts";

// film:gate: every sung word's token drawn on the frame holding its start (within one frame),
// read from the tokens sidecar; N/N or exit 3 with one line per word not drawn.

type Word = { i: number; w: string; line: number; t0: number };
let dir = "";
let words: Word[] = [];
before(() => {
  dir = tempDir("gate");
  cpSync(join(boardFixture, "analysis"), dir, { recursive: true });
  words = JSON.parse(readFileSync(join(dir, "words.json"), "utf8")).words;
});

// A sidecar over song frames [a, b] drawing each word from `shift` frames after its start
// frame to the end, except the words in `skip`.
function sidecar(name: string, a: number, b: number, shift = 0, skip: number[] = []): string {
  const frames = [];
  for (let f = a; f <= b; f++) {
    const tokens = words.filter((w) => !skip.includes(w.i) && f >= Math.floor(w.t0 * 24) + shift).map((w) => ({ word: w.i, text: w.w }));
    frames.push({ t: f / 24, tokens });
  }
  writeFileSync(join(dir, name), JSON.stringify({ fps: 24, chapter: "ch01", frames }));
  return name;
}

const ARGS = (tokens: string, out: string) => ["--tokens", tokens, "--words", "words.json", "--display", "display.txt", "--out", out];

test("every word drawn on its frame: N/N, exit 0, the report written", () => {
  const result = film("gate", dir, ARGS(sidecar("all.json", 0, 287), "ok"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["gate: 12/12"]);
  const report = JSON.parse(readFileSync(join(dir, "ok", "gate-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.drawn, 12);
  assert.deepEqual(report.missing, []);
});

test("a word drawn one frame late still passes; two frames late does not", () => {
  assert.equal(film("gate", dir, ARGS(sidecar("late1.json", 0, 287, 1), "late1")).status, 0);
  const result = film("gate", dir, ARGS(sidecar("late2.json", 0, 287, 2), "late2"));
  assert.equal(result.status, 3);
  assert.equal(lines(result.stdout)[0], "gate: 0/12");
});

test("a word never drawn fails with exit 3, one line per word, the report written", () => {
  const result = film("gate", dir, ARGS(sidecar("miss.json", 0, 287, 0, [6, 10]), "miss"));
  assert.equal(result.status, 3);
  assert.deepEqual(lines(result.stdout), [
    "gate: 10/12",
    'gate: word 6 "windows" at 4.730 s (frame 113) is not drawn',
    'gate: word 10 "the" at 9.170 s (frame 220) is not drawn',
  ]);
  const report = JSON.parse(readFileSync(join(dir, "miss", "gate-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((m: Word) => m.i), [6, 10]);
});

test("only the words inside the sidecar's span count (a chapter or a --range)", () => {
  const result = film("gate", dir, ARGS(sidecar("part.json", 24, 96), "part"));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), ["gate: 5/5"]);
});

test("refusals: missing flags, a file that is not a sidecar, a display that does not consume its words", () => {
  const cases: [string[], string[]][] = [
    [["--tokens", "all.json"], ["film:gate: --tokens, --words, --display and --out are required"]],
    [ARGS("words.json", "x"), ["--tokens is not a tokens sidecar ({fps: 24, frames: [{t, tokens: [{word, text}]}]})"]],
    [ARGS("nothing.json", "x"), ["--tokens cannot be read"]],
  ];
  writeFileSync(join(dir, "bad-display.txt"), "The city wakes.\nWe count|2 the windows.\nHold on,\nhold the light.\n");
  cases.push([["--tokens", "all.json", "--words", "words.json", "--display", "bad-display.txt", "--out", "x"], ['--display line 1 ("We count|2 the windows.") shows 5 sung words, words.json has 4']]);
  for (const [args, want] of cases) {
    const result = film("gate", dir, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), want);
  }
  assert.equal(existsSync(join(dir, "x")), false);
});
