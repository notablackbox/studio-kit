import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, song, tempDir, truthWords, worstMiss, type Truth } from "./fixtures/film.ts";

// film:beats on the synthetic song's drum stem: the tempo drifts from 120 to 123 BPM, the kick
// is on beats 1 and 3, the snare on 2 and 4, a hat on every off-beat.

type Beats = {
  duration: number;
  beats: number[];
  downbeats: number[];
  tempo: { t: number; bpm: number }[];
  downbeat_phase: number;
  downbeat_method: string;
  sections: { name: string; t0: number; t1: number; energy: number; bar0: number; bar1: number; source: string }[];
};

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
});

const read = (out: string): Beats => JSON.parse(readFileSync(join(out, "beats.json"), "utf8"));

test("every beat of the drifting grid is within 30 ms of a map beat, and the tempo rises", () => {
  const result = film("beats", dir, ["--drums", "drums.wav", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const map = read(join(dir, "a"));
  const worst = worstMiss(truth.beats, map.beats);
  assert.ok(worst <= 0.03, `worst beat ${worst.toFixed(4)} s off`);
  // No beat between two of the truth's: the map is not at double time.
  assert.ok(map.beats.filter((t) => t >= truth.beats[0] - 0.03 && t <= truth.beats.at(-1)! + 0.03).length === truth.beats.length);
  for (let i = 1; i < map.beats.length; i++) assert.ok(map.beats[i] > map.beats[i - 1]);
  assert.ok(Math.abs(map.duration - truth.duration) < 0.001);

  assert.ok(map.tempo.length >= 2, JSON.stringify(map.tempo));
  for (const { t, bpm } of map.tempo) {
    assert.ok(t >= 0 && t < map.duration);
    assert.ok(bpm > 119 && bpm < 124, String(bpm));
    assert.ok(Math.abs(bpm * 20 - Math.round(bpm * 20)) < 1e-6, `BPM in 0.05 steps: ${bpm}`);
  }
  assert.ok(map.tempo.at(-1)!.bpm > map.tempo[0].bpm, `tempo ${JSON.stringify(map.tempo)} does not rise`);

  const report = JSON.parse(readFileSync(join(dir, "a", "beats-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { drums: join(dir, "drums.wav"), lyrics: null, words: null, downbeat_phase: null, tempo_range: [70, 180] });
  assert.deepEqual(report.outputs, { beats: "beats.json", report: "beats-report.json" });
  assert.match(lines(result.stdout)[0], /^beats: \d+ beats, \d+ bars, 1\d\d\.\d+ to 1\d\d\.\d+ BPM, downbeats by kick \(phase \d\)$/);
});

test("the kick vote puts the downbeats on the truth's bar starts", () => {
  const result = film("beats", dir, ["--drums", "drums.wav", "--out", "b"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const map = read(join(dir, "b"));
  assert.equal(map.downbeat_method, "kick");
  assert.deepEqual(map.downbeats, map.beats.filter((_, i) => i % 4 === map.downbeat_phase));
  assert.ok(worstMiss(truth.downbeats, map.downbeats) <= 0.03, "a bar start of the truth has no downbeat");
  const inside = map.downbeats.filter((t) => t >= truth.beats[0] - 0.03 && t <= truth.beats.at(-1)! + 0.03);
  assert.ok(worstMiss(inside, truth.downbeats) <= 0.03, "a downbeat falls off the truth's bar starts");
  // One section, by the heuristic, with no lyric sheet.
  assert.equal(map.sections.length, 1);
  assert.equal(map.sections[0].source, "heuristic");
  assert.equal(map.sections[0].t0, 0);
  assert.equal(map.sections[0].t1, map.duration);
});

test("--downbeat-phase sets the downbeats by hand", () => {
  const result = film("beats", dir, ["--drums", "drums.wav", "--out", "c", "--downbeat-phase", "2"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const map = read(join(dir, "c"));
  assert.equal(map.downbeat_method, "manual");
  assert.equal(map.downbeat_phase, 2);
  assert.deepEqual(map.downbeats, map.beats.filter((_, i) => i % 4 === 2));
});

test("hat-only bars change nothing: the beats and downbeats hold", () => {
  const hats = song(["--hats-only", "2,3"]);
  const result = film("beats", hats.dir, ["--drums", "drums.wav", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const map = read(join(hats.dir, "out"));
  assert.ok(worstMiss(hats.truth.beats, map.beats) <= 0.03);
  assert.ok(worstMiss(hats.truth.downbeats, map.downbeats) <= 0.03);
});

test("sections come from the lyric sheet's tags: evenly by bars without words, from the first word with them", () => {
  const even = film("beats", dir, ["--drums", "drums.wav", "--out", "d", "--lyrics", "lyrics.txt"]);
  assert.equal(even.status, 0, even.stdout + even.stderr);
  const map = read(join(dir, "d"));
  // Without words the times are a guess: named by the tags, but heuristic.
  assert.deepEqual(map.sections.map((s) => [s.name, s.source]), [["Verse", "heuristic"], ["Chorus", "heuristic"]]);
  assert.equal(map.sections[0].t0, 0);
  assert.equal(map.sections[0].bar0, 0);
  assert.equal(map.sections[1].t0, map.sections[0].t1);
  assert.equal(map.sections[1].t1, map.duration);
  assert.ok(map.downbeats.includes(map.sections[1].t0), "a section starts on a downbeat");
  assert.ok(Math.abs((map.sections[1].bar0 - 0) - (map.sections[1].bar1 - map.sections[1].bar0)) <= 1, "the bars are shared evenly");
  for (const s of map.sections) assert.ok(s.energy >= 0 && s.energy <= 1);

  const words = truthWords(truth, join(dir, "words.json"));
  const timed = film("beats", dir, ["--drums", "drums.wav", "--out", "e", "--lyrics", "lyrics.txt", "--words", words]);
  assert.equal(timed.status, 0, timed.stdout + timed.stderr);
  const sections = read(join(dir, "e")).sections;
  assert.deepEqual(sections.map((s) => [s.name, s.source]), [["Verse", "lyrics-tag"], ["Chorus", "lyrics-tag"]]);
  assert.ok(Math.abs(sections[1].t0 - truth.sections[1].start) <= 0.03, `chorus at ${sections[1].t0}, truth ${truth.sections[1].start}`);
});

test("two adjacent tags never make a zero-length section: the empty one is merged, with a note", () => {
  // [Intro] has no line of its own, and [Bridge] none either, at the end.
  writeFileSync(
    join(dir, "tags.txt"),
    "[Intro]\n[Verse - spoken]\nthe city wakes\nwe count the windows\n[Chorus]\nhold on\nhold the light\n[Bridge]\n",
  );
  const words = truthWords(truth, join(dir, "words-tags.json"));
  for (const [out, extra] of [["t1", []], ["t2", ["--words", words]]] as const) {
    const result = film("beats", dir, ["--drums", "drums.wav", "--out", out, "--lyrics", "tags.txt", ...extra]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const map = read(join(dir, out));
    assert.deepEqual(map.sections.map((s) => s.name), ["Verse", "Chorus"], out);
    for (const s of map.sections) assert.ok(s.t1 > s.t0 && s.bar1 > s.bar0, `${out}: ${JSON.stringify(s)}`);
    assert.equal(map.sections[0].t0, 0);
    assert.equal(map.sections.at(-1)!.t1, map.duration);
    const report = JSON.parse(readFileSync(join(dir, out, "beats-report.json"), "utf8"));
    assert.deepEqual(report.section_notes, [
      "[Intro] has no lyric line of its own: merged into Verse",
      "[Bridge] has no lyric line of its own: merged into Chorus",
    ]);
  }

  // Two tags with lines whose first words fall on the same downbeat: the later is merged.
  writeFileSync(join(dir, "three.txt"), "[Verse]\nthe city wakes\n[Pre]\nwe count the windows\n[Chorus]\nhold on\nhold the light\n");
  const moved = JSON.parse(readFileSync(words, "utf8"));
  for (const w of moved.words) if (w.line === 2) w.t0 = 3.2; // "hold on" moved into the bar of "we count"
  writeFileSync(join(dir, "words-moved.json"), JSON.stringify(moved));
  const result = film("beats", dir, ["--drums", "drums.wav", "--out", "t3", "--lyrics", "three.txt", "--words", "words-moved.json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const map = read(join(dir, "t3"));
  assert.deepEqual(map.sections.map((s) => [s.name, s.source]), [["Verse", "lyrics-tag"], ["Pre", "lyrics-tag"]]);
  for (const s of map.sections) assert.ok(s.t1 > s.t0);
  const report = JSON.parse(readFileSync(join(dir, "t3", "beats-report.json"), "utf8"));
  assert.deepEqual(report.section_notes, ["[Chorus] starts on the same downbeat as Pre: merged into Pre"]);
});

test("a silent drum stem fails: exit 3, one line, the report written and no beats.json", () => {
  // Ten seconds of digital silence, 44.1 kHz 16-bit mono.
  const rate = 44100;
  const samples = rate * 10;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  writeFileSync(join(dir, "silent-drums.wav"), wav);
  const out = join(dir, "silent");
  const result = film("beats", dir, ["--drums", "silent-drums.wav", "--out", "silent"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["beats: the drum stem is silent (no onsets)"]);
  assert.deepEqual(readdirSync(out), ["beats-report.json"]);
  const report = JSON.parse(readFileSync(join(out, "beats-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.deepEqual(report.outputs, { report: "beats-report.json" });
  assert.equal(report.onset_peak, 0);
  assert.ok(report.onset_floor > 0);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "noise.txt"), "not audio at all\n");
  writeFileSync(join(dir, "bad-words.json"), "{\"words\": 3}\n");
  const cases: [string[], string][] = [
    [["--out", "x"], "film:beats: --drums <path> and --out <dir> are required"],
    [["--drums", "missing.wav", "--out", "x"], "--drums cannot be read"],
    [["--drums", "noise.txt", "--out", "x"], "--drums cannot be read as audio"],
    [["--drums", "drums.wav", "--out", "x", "--downbeat-phase", "4"], "--downbeat-phase wants 0, 1, 2 or 3"],
    [["--drums", "drums.wav", "--out", "x", "--tempo-range", "200,100"], "--tempo-range wants low,high in BPM, between 40 and 300"],
    [["--drums", "drums.wav", "--out", "x", "--lyrics", "nope.txt"], "--lyrics cannot be read"],
    [["--drums", "drums.wav", "--out", "x", "--words", "bad-words.json"], "--words needs --lyrics"],
    [["--drums", "drums.wav", "--out", "x", "--lyrics", "lyrics.txt", "--words", "bad-words.json"], "--words is not a words.json"],
    [["--drums", "drums.wav", "--out", "lyrics.txt"], "--out is not a folder"],
  ];
  for (const [args, line] of cases) {
    const result = film("beats", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(result.stderr, "");
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("beats", dir, ["--drums", "drums.wav", "--out", "y"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:beats: python film_py.beats failed"]);
  assert.ok(!existsSync(join(dir, "y")) || readdirSync(join(dir, "y")).length === 0);
});
