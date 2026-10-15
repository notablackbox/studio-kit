import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, readWav, song, truthWords } from "./fixtures/film.ts";
import { boardFixture } from "./fixtures/board.ts";

// film:sync measures a delivered take's soundtrack against the clean vocal window it was given
// (wiki/toolkit item 15): mel spectrograms at 16 kHz, the global lag within 1 s, the NCC over
// time in 0.5 s windows, the in-sync spans, where it diverges and the last eighth note before
// that, in song time; a diagnostic PNG. A take that does not copy the window is exit 3.

let dir = "";
let t0 = 0;
let window: Float64Array;
const beatsFile = join(boardFixture, "analysis", "beats.json");
const beats: number[] = JSON.parse(readFileSync(beatsFile, "utf8")).beats;
const eighths = beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]) / 2] : [b]));

before(() => {
  let truth;
  ({ dir, truth } = song());
  truthWords(truth, join(dir, "words.json"));
  // The window from the shot's start, 0.05 s before the first word, for a 5 s clip.
  const start = Math.round((truth.words[0].start - 0.05) * 10000) / 10000;
  const made = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(start), "--duration", "5", "--from", "0", "--to", "6", "--name", "W01", "--out", "w"]);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  // --song-t0 is the window's song_t0: the song time of its first sample.
  t0 = JSON.parse(readFileSync(join(dir, "w", "window-report.json"), "utf8")).song_t0;
  assert.equal(t0, start);
  window = readWav(join(dir, "w", "W01.wav")).mono;
});

// A 16-bit mono 44.1 kHz WAV of `x`.
function writeWav(file: string, x: Float64Array): string {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(44100, 24);
  head.writeUInt32LE(88200, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  writeFileSync(join(dir, file), Buffer.concat([head, data]));
  return file;
}

// White noise from a fixed seed, at about -20 dBFS RMS.
function noise(n: number, seed = 7): Float64Array {
  let s = seed;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = (s / 2147483648 - 0.5) * 0.35;
  }
  return out;
}

const SYNC = (take: string, out: string) => ["--take", take, "--window", "w/W01.wav", "--beats", beatsFile, "--song-t0", String(t0), "--out", out];
const report = (out: string) => JSON.parse(readFileSync(join(dir, out, "sync-report.json"), "utf8"));
const isPng = (file: string) => readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

test("the take is the window itself: NCC near 1, lag 0, a copy synced throughout", () => {
  const result = film("sync", dir, SYNC("w/W01.wav", "same"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const r = report("same");
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, { take: join(dir, "w", "W01.wav"), window: join(dir, "w", "W01.wav"), beats: beatsFile, song_t0: t0 });
  assert.deepEqual(r.outputs, { png: "W01-sync.png", report: "sync-report.json" });
  assert.deepEqual(Object.keys(r.sync), ["lag_s", "ncc", "mode", "synced", "diverge_at", "cut_at"]);
  assert.ok(Math.abs(r.sync.lag_s) <= 0.01, `lag ${r.sync.lag_s}`);
  assert.ok(r.sync.ncc > 0.95, `ncc ${r.sync.ncc}`);
  assert.equal(r.sync.mode, "copy");
  assert.equal(r.sync.diverge_at, null);
  assert.equal(r.sync.cut_at, null);
  // One span over the whole voiced window, in song time.
  assert.equal(r.sync.synced.length, 1);
  const length = window.length / 44100;
  assert.ok(r.sync.synced[0][0] <= t0 + 0.2 && r.sync.synced[0][1] >= t0 + length - 0.6, JSON.stringify(r.sync.synced));
  assert.ok(isPng(join(dir, "same", "W01-sync.png")));
  assert.deepEqual(readdirSync(join(dir, "same")).sort(), ["W01-sync.png", "sync-report.json"]);
  assert.match(lines(result.stdout)[0], /^sync: "W01\.wav" copy, lag 0\.00 s, NCC (0\.9\d|1\.00), synced \d+\.\d\d to \d+\.\d\d, no divergence$/);
});

test("the take is an MP4 holding the window: its audio is extracted", () => {
  const made = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24", "-i", "w/W01.wav", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "192k", "take-1.mp4"], { cwd: dir, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const result = film("sync", dir, SYNC("take-1.mp4", "mp4"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const r = report("mp4");
  assert.ok(Math.abs(r.sync.lag_s) <= 0.03, `lag ${r.sync.lag_s}`);
  assert.ok(r.sync.ncc > 0.9, `ncc ${r.sync.ncc}`);
  assert.equal(r.sync.mode, "copy");
  assert.ok(existsSync(join(dir, "mp4", "take-1-sync.png")));
});

test("the window with 0.3 s of silence before it: lag 0.3", () => {
  const take = new Float64Array(window.length + Math.round(0.3 * 44100));
  take.set(window, Math.round(0.3 * 44100));
  const result = film("sync", dir, SYNC(writeWav("late.wav", take), "late"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const r = report("late");
  assert.ok(Math.abs(r.sync.lag_s - 0.3) <= 0.01, `lag ${r.sync.lag_s}`);
  assert.ok(r.sync.ncc > 0.95, `ncc ${r.sync.ncc}`);
  assert.equal(r.sync.mode, "copy");
  assert.equal(r.sync.diverge_at, null);
  // Spans are in song time: the lag is taken out.
  assert.ok(r.sync.synced[0][0] <= t0 + 0.2, JSON.stringify(r.sync.synced));
  assert.match(lines(result.stdout)[0], /lag 0\.30 s/);
});

test("a take that starts 0.3 s into the window: lag -0.3, the curve starts where the take does", () => {
  const take = window.slice(Math.round(0.3 * 44100));
  const result = film("sync", dir, SYNC(writeWav("early.wav", take), "early"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const r = report("early");
  assert.ok(Math.abs(r.sync.lag_s + 0.3) <= 0.01, `lag ${r.sync.lag_s}`);
  assert.ok(r.sync.ncc > 0.95);
  // The first measured window is the window's 0.3 s mark, in song time.
  assert.ok(Math.abs(r.curve.t0 - (t0 + 0.3)) <= 0.011, `curve t0 ${r.curve.t0}, want ${(t0 + 0.3).toFixed(4)}`);
  assert.equal(r.sync.diverge_at, null);
});

test("a take shorter than the window: the missing tail diverges from the take's end", () => {
  const take = window.slice(0, Math.round(3.0 * 44100));
  const result = film("sync", dir, SYNC(writeWav("short.wav", take), "short"));
  const r = report("short");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(r.sync.mode, "copy");
  assert.ok(Math.abs(r.sync.diverge_at - (t0 + 3.0)) <= 0.011, `diverge_at ${r.sync.diverge_at}, want ${(t0 + 3).toFixed(4)}`);
  assert.ok(r.sync.cut_at <= r.sync.diverge_at && eighths.some((e) => Math.abs(e - r.sync.cut_at) < 1e-3));
  assert.ok(r.sync.synced.every(([, b]: [number, number]) => b <= r.sync.diverge_at + 1e-6), JSON.stringify(r.sync.synced));
});

test("the window with white noise after 2 s: it diverges at about 2.0, cut on an eighth before it", () => {
  const take = Float64Array.from(window);
  const at = Math.round(2.0 * 44100);
  take.set(noise(take.length - at), at);
  const result = film("sync", dir, SYNC(writeWav("noisy.wav", take), "noisy"));
  const r = report("noisy");
  assert.equal(result.status, r.sync.mode === "copy" ? 0 : 3, result.stdout + result.stderr);
  assert.equal(r.sync.mode, "copy", `ncc ${r.sync.ncc}`);
  assert.ok(Math.abs(r.sync.lag_s) <= 0.01);
  const diverge = r.sync.diverge_at;
  assert.ok(Math.abs(diverge - (t0 + 2.0)) <= 0.15, `diverge_at ${diverge}, want about ${(t0 + 2).toFixed(3)}`);
  // The cut is the last eighth note at or before the divergence.
  const cut = r.sync.cut_at;
  assert.ok(eighths.some((e) => Math.abs(e - cut) < 1e-3), `cut_at ${cut} is not an eighth`);
  assert.ok(cut <= diverge);
  assert.ok(!eighths.some((e) => e > cut + 1e-3 && e <= diverge), "an eighth sits between the cut and the divergence");
  // Synced up to the divergence, not after.
  assert.ok(r.sync.synced.length >= 1);
  assert.ok(r.sync.synced.every(([a, b]: [number, number]) => a < b && b <= diverge + 0.05), JSON.stringify(r.sync.synced));
  assert.match(lines(result.stdout)[0], new RegExp(`diverges at ${diverge.toFixed(2)}, cut at ${cut.toFixed(2)}$`));
});

test("a take that does not copy the window is diverged: exit 3, one line, the report written", () => {
  const result = film("sync", dir, SYNC(writeWav("other.wav", noise(window.length, 99)), "other"));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const r = report("other");
  assert.equal(r.ok, false);
  assert.equal(r.sync.mode, "diverged");
  assert.ok(r.sync.ncc <= 0.2);
  assert.deepEqual(lines(result.stdout), [`sync: "other.wav" does not copy the window (NCC ${r.sync.ncc.toFixed(2)}, want over 0.2)`]);
  assert.ok(isPng(join(dir, "other", "other-sync.png")));
});

test("refusals: one line each, exit 2, nothing written", () => {
  const silent = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24", "-t", "1", "-c:v", "mpeg4", "mute.mp4"], { cwd: dir, encoding: "utf8" });
  assert.equal(silent.status, 0, silent.stderr);
  writeFileSync(join(dir, "text.wav"), "not audio");
  writeFileSync(join(dir, "badbeats.json"), '{"beats": "x"}');
  writeFileSync(join(dir, "afile"), "");
  const base = (take: string, extra: string[] = []) => ["--take", take, "--window", "w/W01.wav", "--beats", beatsFile, "--song-t0", "1", "--out", "x", ...extra];
  const cases: [string[], string][] = [
    [["--take", "w/W01.wav", "--out", "x"], "film:sync: --take, --window, --beats, --song-t0 and --out are required"],
    [base("mute.mp4"), "--take has no audio stream"],
    [base("text.wav"), "--take has no audio stream"],
    [base("nope.mp4"), "--take cannot be read"],
    [["--take", "w/W01.wav", "--window", "text.wav", "--beats", beatsFile, "--song-t0", "1", "--out", "x"], "--window cannot be read as audio"],
    [["--take", "w/W01.wav", "--window", "w/W01.wav", "--beats", "badbeats.json", "--song-t0", "1", "--out", "x"], "--beats is not a beats.json"],
    [["--take", "w/W01.wav", "--window", "w/W01.wav", "--beats", beatsFile, "--song-t0", "soon", "--out", "x"], '--song-t0 is "soon", want seconds from 0'],
    [["--take", "w/W01.wav", "--window", "w/W01.wav", "--beats", beatsFile, "--song-t0", "1", "--out", "afile"], "--out is not a folder"],
  ];
  for (const [flags, want] of cases) {
    const result = film("sync", dir, flags);
    assert.equal(result.status, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [want], flags.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("sync", dir, SYNC("w/W01.wav", "y"), { FILM_PYTHON: "false" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:sync: python film_py.sync failed"]);
  assert.equal(existsSync(join(dir, "y")), false);
});
