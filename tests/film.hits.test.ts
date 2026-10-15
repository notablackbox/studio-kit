import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, song, worstMiss, type Truth } from "./fixtures/film.ts";

// film:hits on the synthetic song's stems: a known list of kicks, snares and hats, and the
// vocal entries at the words that follow silence.

type Hits = {
  kick: number[];
  snare: number[];
  hat: number[];
  hits: { t: number; score: number }[];
  risers: { t0: number; t1: number; land: number }[];
  fills: { t0: number; t1: number }[];
  vocal_entries: number[];
  env24: { drums: number[]; vocals: number[]; bass: number[] };
};

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
  // The stems folder film:stems would write; the fixture has only these two stems.
  mkdirSync(join(dir, "stems"));
  renameSync(join(dir, "drums.wav"), join(dir, "stems", "drums.wav"));
  renameSync(join(dir, "vocals.wav"), join(dir, "stems", "vocals.wav"));
});

const read = (out: string): Hits => JSON.parse(readFileSync(join(out, "hits.json"), "utf8"));

test("every kick and every hat of the truth is found within 20 ms, and no kick is invented", () => {
  const result = film("hits", dir, ["--stems", "stems", "--mix", "song.wav", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const hits = read(join(dir, "a"));
  assert.ok(worstMiss(truth.kicks, hits.kick) <= 0.02, `kick off by ${worstMiss(truth.kicks, hits.kick)}`);
  assert.ok(worstMiss(hits.kick, truth.kicks) <= 0.02, `a kick where the truth has none`);
  assert.ok(worstMiss(truth.hats, hits.hat) <= 0.02, `hat off by ${worstMiss(truth.hats, hits.hat)}`);
  assert.ok(worstMiss(truth.snares, hits.snare) <= 0.02, `snare off by ${worstMiss(truth.snares, hits.snare)}`);
  // The 45 ms rules: nothing in the snare or hat lists sits on a kick, no hat on a snare.
  for (const t of [...hits.snare, ...hits.hat]) assert.ok(worstMiss([t], hits.kick) > 0.045, `${t} is a kick's click`);
  for (const t of hits.hat) assert.ok(worstMiss([t], hits.snare) > 0.045, `${t} is a snare's noise`);
  // Precision: every snare and hat found is one the song plays.
  assert.ok(worstMiss(hits.snare, truth.snares) <= 0.02, `a snare where the truth has none: ${hits.snare.length} found`);
  assert.ok(worstMiss(hits.hat, truth.hats) <= 0.02, `a hat where the truth has none: ${hits.hat.length} found`);

  const report = JSON.parse(readFileSync(join(dir, "a", "hits-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, {
    stems: join(dir, "stems"),
    mix: join(dir, "song.wav"),
    beats: null,
    used: ["drums.wav", "vocals.wav"],
    absent: ["bass.wav", "other.wav"],
  });
  assert.deepEqual(report.outputs, { hits: "hits.json", report: "hits-report.json" });
  assert.match(lines(result.stdout)[0], /^hits: \d+ kicks, \d+ snares, \d+ hats, \d+ hits, \d+ risers, \d+ fills, \d+ vocal entries$/);
});

test("no spurious kick in the hat-only bars", () => {
  const hats = song(["--hats-only", "2,3"]);
  mkdirSync(join(hats.dir, "stems"));
  renameSync(join(hats.dir, "drums.wav"), join(hats.dir, "stems", "drums.wav"));
  renameSync(join(hats.dir, "vocals.wav"), join(hats.dir, "stems", "vocals.wav"));
  const result = film("hits", hats.dir, ["--stems", "stems", "--mix", "song.wav", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const found = read(join(hats.dir, "out"));
  const [from, to] = [hats.truth.beats[8], hats.truth.beats[16]];
  assert.deepEqual(found.kick.filter((t) => t > from - 0.02 && t < to - 0.02), [], "kicks in bars 2 and 3");
  assert.deepEqual(found.snare.filter((t) => t > from - 0.02 && t < to - 0.02), [], "snares in bars 2 and 3");
  assert.ok(worstMiss(hats.truth.kicks, found.kick) <= 0.02);
  assert.ok(worstMiss(found.kick, hats.truth.kicks) <= 0.02);
  assert.ok(worstMiss(hats.truth.snares, found.snare) <= 0.02);
  assert.ok(worstMiss(found.snare, hats.truth.snares) <= 0.02, "a snare the song does not play");
  assert.ok(worstMiss(hats.truth.hats, found.hat) <= 0.02);
  assert.ok(worstMiss(found.hat, hats.truth.hats) <= 0.02, "a hat the song does not play");
});

test("vocal entries are word starts after silence; the first word is one", () => {
  const hits = read(join(dir, "a"));
  assert.ok(hits.vocal_entries.length >= 2, JSON.stringify(hits.vocal_entries));
  const starts = truth.words.map((w) => w.start);
  assert.ok(worstMiss(hits.vocal_entries, starts) <= 0.02, `an entry off a word start: ${hits.vocal_entries}`);
  assert.ok(Math.abs(hits.vocal_entries[0] - truth.words[0].start) <= 0.02);
  // Every word after at least half a second of silence is an entry.
  for (let i = 1; i < truth.words.length; i++) {
    if (truth.words[i].start - truth.words[i - 1].end >= 0.5) {
      assert.ok(worstMiss([truth.words[i].start], hits.vocal_entries) <= 0.02, `word ${i} is not an entry`);
    }
  }
});

test("hits, risers and env24 have the formats' shape; the drums' start is a hit", () => {
  const hits = read(join(dir, "a"));
  assert.ok(hits.hits.length >= 1);
  for (const h of hits.hits) assert.ok(h.score >= 0.22 && h.score <= 1 && h.t >= 0 && h.t <= truth.duration);
  for (let i = 1; i < hits.hits.length; i++) assert.ok(hits.hits[i].t - hits.hits[i - 1].t >= 2, "hits merged within 2 s");
  assert.ok(worstMiss([truth.beats[0]], hits.hits.map((h) => h.t)) <= 0.02, "the drums coming in are a hit, on their first kick");
  for (const r of hits.risers) assert.ok(r.t0 < r.t1 && r.land === r.t1);
  const frames = Math.ceil(truth.duration * 24);
  for (const key of ["drums", "vocals", "bass"] as const) {
    const env = hits.env24[key];
    assert.equal(env.length, frames, key);
    for (const v of env) assert.ok(v >= 0 && v <= 1, `${key} ${v}`);
  }
  assert.equal(Math.max(...hits.env24.drums), 1);
  assert.equal(Math.max(...hits.env24.vocals), 1);
  assert.equal(Math.max(...hits.env24.bass), 0, "no bass stem: a silent envelope");
  // Before the first beat the drums are silent.
  assert.equal(hits.env24.drums[0], 0);
});

test("with --beats, fills are the beat before each hit", () => {
  const beats = film("beats", dir, ["--drums", "stems/drums.wav", "--out", "b"]);
  assert.equal(beats.status, 0, beats.stdout + beats.stderr);
  const result = film("hits", dir, ["--stems", "stems", "--mix", "song.wav", "--out", "b", "--beats", "b/beats.json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const hits = read(join(dir, "b"));
  const map = JSON.parse(readFileSync(join(dir, "b", "beats.json"), "utf8"));
  for (const h of hits.hits) {
    const before = map.beats.filter((t: number) => t < h.t - 0.03);
    if (before.length === 0) continue;
    assert.ok(hits.fills.some((f) => Math.abs(f.t1 - h.t) < 1e-6 && Math.abs(f.t0 - before.at(-1)) < 1e-6), `no fill before the hit at ${h.t}`);
  }
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "noise.wav"), "RIFF but not really");
  const cases: [string[], string][] = [
    [["--stems", "stems", "--out", "x"], "film:hits: --stems <dir>, --mix <path> and --out <dir> are required"],
    [["--stems", "empty", "--mix", "song.wav", "--out", "x"], "--stems has no drums.wav"],
    [["--stems", "nope", "--mix", "song.wav", "--out", "x"], "--stems is not a folder"],
    [["--stems", "stems", "--mix", "noise.wav", "--out", "x"], "--mix cannot be read as audio"],
    [["--stems", "stems", "--mix", "song.wav", "--out", "x", "--beats", "lyrics.txt"], "--beats is not a beats.json"],
  ];
  for (const [args, line] of cases) {
    const result = film("hits", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("hits", dir, ["--stems", "stems", "--mix", "song.wav", "--out", "y"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:hits: python film_py.hits failed"]);
});
