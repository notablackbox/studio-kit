import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, kitRoot, lines, song, tempDir, type Truth } from "./fixtures/film.ts";

// A WAV's format and length from its header (fixtures/film.ts reads 16 and 32 bit only).
function wavInfo(file: string): { rate: number; bits: number; channels: number; seconds: number } {
  const data = readFileSync(file);
  let at = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  let seconds = 0;
  while (at + 8 <= data.length) {
    const id = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = data.readUInt16LE(at + 10);
      rate = data.readUInt32LE(at + 12);
      bits = data.readUInt16LE(at + 22);
    } else if (id === "data") seconds = size / (rate * channels * (bits / 8));
    at += 8 + size + (size % 2);
  }
  return { rate, bits, channels, seconds };
}

// film:mix: the master plus the chapters' sound events, ducked under the vocal stem, at the
// master's own loudness (within 1 LU), written 48 kHz 24-bit.

let dir = "";
let sounds = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
  sounds = tempDir("sounds");
  const made = spawnSync("python3", ["-I", "-B", "src/film/py/film_py/sounds.py", "--dest", sounds], { cwd: kitRoot, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  writeFileSync(join(dir, "ch01.audio.json"), JSON.stringify([{ t: 2.0, kind: "tick", gain: 0.35 }]));
  writeFileSync(join(dir, "ch02.audio.json"), JSON.stringify([{ t: 6.5, kind: "whoosh", gain: 0.45 }]));
});

test("the sounds are made at build: four 48 kHz 24-bit WAVs, the same bytes every run", () => {
  assert.deepEqual(readdirSync(sounds).sort(), ["stamp.wav", "tick.wav", "type.wav", "whoosh.wav"]);
  assert.deepEqual(wavInfo(join(sounds, "whoosh.wav")), { rate: 48000, bits: 24, channels: 1, seconds: 0.45 });
  const again = tempDir("sounds");
  spawnSync("python3", ["-I", "-B", "src/film/py/film_py/sounds.py", "--dest", again], { cwd: kitRoot });
  assert.ok(readFileSync(join(again, "tick.wav")).equals(readFileSync(join(sounds, "tick.wav"))));
});

// The mix's own samples, mono at 48 kHz, and the master's, decoded the same way by ffmpeg.
function samples(file: string): Float32Array {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(raw.status, 0);
  const buf = raw.stdout as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
const energyDb = (x: Float32Array, t0: number, t1: number) => {
  let sum = 0;
  const a = Math.round(t0 * 48000);
  const b = Math.round(t1 * 48000);
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / (b - a) + 1e-20);
};

test("a mix with two events, measured within 1 LU of the master", () => {
  const result = film("mix", dir, ["--master", "song.wav", "--events", "ch01.audio.json", "ch02.audio.json", "--vocals", "vocals.wav", "--sounds", sounds, "--out", "mix"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^mix: 2 events under the master, -?\d+(\.\d+)? LUFS \(the master -?\d+(\.\d+)? LUFS, [+-]\d+(\.\d+)? LU\), mix\.wav 48 kHz 24-bit$/);
  const report = JSON.parse(readFileSync(join(dir, "mix", "mix-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.ok(Math.abs(report.loudness.delta_lu) <= 1, JSON.stringify(report.loudness));
  assert.deepEqual(report.events, [{ t: 2, kind: "tick", gain: 0.35 }, { t: 6.5, kind: "whoosh", gain: 0.45 }]);
  const wav = wavInfo(join(dir, "mix", "mix.wav"));
  assert.equal(wav.rate, 48000);
  assert.equal(wav.bits, 24);
  assert.equal(wav.channels, 2);
  assert.ok(Math.abs(wav.seconds - 12) < 0.05, String(wav.seconds));
  assert.deepEqual(readdirSync(join(dir, "mix")).sort(), ["mix-report.json", "mix.wav"]);
});

test("each event sits at its time, and one under a sung word is ducked 6 dB or more below one in silence", () => {
  // The same sound twice: in the silence before the first word, and inside the second word.
  const sung = truth.words[1];
  const quiet = 0.3;
  const loud = Math.round((sung.start + 0.05) * 1000) / 1000;
  assert.ok(sung.end - loud > 0.13 && truth.words[0].start - quiet > 0.4);
  writeFileSync(join(dir, "duck.audio.json"), JSON.stringify([{ t: quiet, kind: "stamp", gain: 0.5 }, { t: loud, kind: "stamp", gain: 0.5 }]));
  const result = film("mix", dir, ["--master", "song.wav", "--events", "duck.audio.json", "--vocals", "vocals.wav", "--sounds", sounds, "--out", "duck"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "duck", "mix-report.json"), "utf8"));
  assert.equal(report.loudness.limiter, false, "levelled without the limiter, so the mix less the master is the events alone");
  // What the events added: the mix less the master at the levelling gain.
  const mix = samples(join(dir, "duck", "mix.wav"));
  const master = samples(join(dir, "song.wav"));
  const g = 10 ** (report.loudness.gain_db / 20);
  const added = new Float32Array(Math.min(mix.length, master.length));
  for (let i = 0; i < added.length; i++) added[i] = mix[i] - g * master[i];
  const at = (t: number) => energyDb(added, t, t + 0.12);
  const before = (t: number) => energyDb(added, t - 0.25, t - 0.02);
  // Each event's energy is at its time: far above the stretch just before it.
  assert.ok(at(quiet) - before(quiet) > 20, `quiet event ${at(quiet)} dB, before it ${before(quiet)} dB`);
  assert.ok(at(loud) - before(loud) > 10, `sung event ${at(loud)} dB, before it ${before(loud)} dB`);
  console.log(`# events: in silence ${at(quiet).toFixed(1)} dB (before it ${before(quiet).toFixed(1)}), under the word ${at(loud).toFixed(1)} dB (before it ${before(loud).toFixed(1)})`);
  // Ducked under her voice.
  assert.ok(at(quiet) - at(loud) >= 6, `in silence ${at(quiet).toFixed(1)} dB, under the word ${at(loud).toFixed(1)} dB`);
});

test("refusals: an event outside the master, a kind with no sound, an unknown kind, missing flags", () => {
  writeFileSync(join(dir, "boom.audio.json"), JSON.stringify([{ t: 1, kind: "boom", gain: 0.3 }]));
  writeFileSync(join(dir, "late.audio.json"), JSON.stringify([{ t: 20, kind: "tick", gain: 0.3 }]));
  const cases: [string[], string[]][] = [
    [["--master", "song.wav"], ["film:mix: --master, --events, --vocals, --sounds and --out are required"]],
    [["--master", "song.wav", "--events", "late.audio.json", "--vocals", "vocals.wav", "--sounds", sounds, "--out", "x"], ['--events: "late.audio.json"[0] at 20.000 s is outside the master (12.000 s)']],
    [["--master", "song.wav", "--events", "boom.audio.json", "--vocals", "vocals.wav", "--sounds", sounds, "--out", "x"], ['--events: "boom.audio.json"[0] kind "boom" is not one of tick, stamp, type, whoosh']],
    [["--master", "song.wav", "--events", "ch01.audio.json", "--vocals", "vocals.wav", "--sounds", dir, "--out", "x"], ["--sounds has no tick.wav (make them with python3 -I src/film/py/film_py/sounds.py --dest <folder>)"]],
  ];
  for (const [args, want] of cases) {
    const result = film("mix", dir, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), want);
  }
  assert.equal(existsSync(join(dir, "x")), false);
});
