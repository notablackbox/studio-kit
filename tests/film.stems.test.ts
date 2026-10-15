import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, film, lines, power, readWav, song, worstMiss, type Truth } from "./fixtures/film.ts";

// film:stems on the synthetic song: htdemucs splits the mix into four stems; the vocal stem
// must hold the words and the drum stem the hits.

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
});

test("four stems, the words in the vocal stem and the hits in the drum stem", () => {
  const result = film("stems", dir, ["--in", "song.wav", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(readdirSync(join(dir, "a", "stems")).sort(), ["bass.wav", "drums.wav", "other.wav", "vocals.wav"]);
  const report = JSON.parse(readFileSync(join(dir, "a", "stems-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { in: join(dir, "song.wav") });
  assert.deepEqual(report.outputs, {
    stems: { vocals: "stems/vocals.wav", drums: "stems/drums.wav", bass: "stems/bass.wav", other: "stems/other.wav" },
    report: "stems-report.json",
  });
  assert.equal(report.model.name, "htdemucs");
  assert.equal(report.model.device, "cpu");
  assert.ok(report.seconds > 0);
  assert.ok(Math.abs(report.duration - truth.duration) < 0.01);
  assert.match(lines(result.stdout)[0], /^stems: 4 stems of 12\.0 s in \d+\.\d s \(htdemucs, cpu\)$/);

  const vocals = readWav(join(dir, "a", "stems", "vocals.wav"));
  const drums = readWav(join(dir, "a", "stems", "drums.wav"));
  for (const wav of [vocals, drums]) {
    assert.deepEqual([wav.rate, wav.channels, wav.bits], [44100, 2, 16]);
    assert.ok(Math.abs(wav.mono.length - truth.duration * 44100) <= 1);
  }

  // Words: the energy inside the known word spans is far above the energy outside them.
  let inside = 0;
  let span = 0;
  for (const w of truth.words) {
    inside += power(vocals.mono, 44100, w.start, w.end) * (w.end - w.start);
    span += w.end - w.start;
  }
  const total = power(vocals.mono, 44100, 0, truth.duration) * truth.duration;
  const outside = (total - inside) / (truth.duration - span);
  const ratio = db(inside / span / outside);
  assert.ok(ratio >= 20, `vocal stem: ${ratio.toFixed(1)} dB inside the words over outside`);

  // Each stem is the song's own part: it follows the fixture's true stem sample for sample.
  assert.ok(correlation(vocals.mono, readWav(join(dir, "vocals.wav")).mono) >= 0.95, "the vocal stem is not the vocals");
  assert.ok(correlation(drums.mono, readWav(join(dir, "drums.wav")).mono) >= 0.95, "the drum stem is not the drums");

  // Hits: the drum stem is silent before the first beat, and film:hits finds every kick, snare
  // and hat of the truth in it within 20 ms.
  const silence = power(drums.mono, 44100, 0, truth.beats[0] - 0.05);
  const loud = power(drums.mono, 44100, truth.beats[0], truth.duration);
  assert.ok(db(loud / Math.max(silence, 1e-12)) >= 30, "the drum stem is silent before the drums");
  const hits = film("hits", dir, ["--stems", "a/stems", "--mix", "song.wav", "--out", "a/hits"]);
  assert.equal(hits.status, 0, hits.stdout + hits.stderr);
  const found = JSON.parse(readFileSync(join(dir, "a", "hits", "hits.json"), "utf8"));
  assert.ok(worstMiss(truth.kicks, found.kick) <= 0.02, `kick ${worstMiss(truth.kicks, found.kick)}`);
  assert.ok(worstMiss(found.kick, truth.kicks) <= 0.02, "a kick the song does not have");
  assert.ok(worstMiss(truth.snares, found.snare) <= 0.02, `snare ${worstMiss(truth.snares, found.snare)}`);
  assert.ok(worstMiss(truth.hats, found.hat) <= 0.02, `hat ${worstMiss(truth.hats, found.hat)}`);
});

function correlation(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
}

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "noise.wav"), "not audio");
  const cases: [string[], string, NodeJS.ProcessEnv?][] = [
    [["--in", "song.wav"], "film:stems: --in <path> and --out <dir> are required"],
    [["--in", "nope.wav", "--out", "x"], "--in cannot be read"],
    [["--in", "noise.wav", "--out", "x"], "--in cannot be read as audio"],
    [["--in", "song.wav", "--out", "lyrics.txt"], "--out is not a folder"],
    [["--in", "song.wav", "--out", "x"], 'model htdemucs is not in "/nowhere" (run python3 -I src/film/py/film_py/models.py --dest "/nowhere")', { FILM_MODELS: "/nowhere" }],
  ];
  for (const [args, line, env] of cases) {
    const result = film("stems", dir, args, env);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("stems", dir, ["--in", "song.wav", "--out", "y"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:stems: python film_py.stems failed"]);
});
