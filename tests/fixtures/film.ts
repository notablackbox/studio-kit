import { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What the listening tests share: the kit root, temp folders removed after the file's tests,
// the synthetic song, a film command run as the sandbox runs it, and a WAV reader.

export const kitRoot = fileURLToPath(new URL("../..", import.meta.url));

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(name = "film"): string {
  const dir = mkdtempSync(join(tmpdir(), `studio-kit-${name}-`));
  temps.push(dir);
  return dir;
}

export type Word = { i: number; word: string; display: string; line: number; section: number; start: number; end: number };
export type Truth = {
  duration: number;
  beats: number[];
  downbeats: number[];
  kicks: number[];
  snares: number[];
  hats: number[];
  sections: { name: string; cue: string; start: number; end: number }[];
  lines: { text: string; display: string; section: number; words: [number, number] }[];
  words: Word[];
  hats_only_bars?: number[];
};

// Builds the synthetic song (tests/fixtures/synth_song.py) into a fresh folder.
export function song(args: string[] = []): { dir: string; truth: Truth } {
  const dir = tempDir("song");
  const result = spawnSync("python3", ["-I", "-B", "tests/fixtures/synth_song.py", "--out", dir, ...args], { cwd: kitRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { dir, truth: JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) };
}

// The truth's words as a words.json, as film:words writes it (every word from the aligner).
export function truthWords(truth: Truth, file: string): string {
  const words = truth.words.map((w) => ({ i: w.i, w: w.word, line: w.line, t0: w.start, t1: w.end, conf: 1, src: "w2v" }));
  const lines = truth.lines.map((l, line) => ({ line, text: l.text, t0: truth.words[l.words[0]].start, t1: truth.words[l.words[1]].end }));
  writeFileSync(file, JSON.stringify({ words, lines, gaps: [] }, null, 2) + "\n");
  return file;
}

// `npm run film:<name> -- <args>` as the sandbox calls it: node and tsx on the command's file,
// with INIT_CWD the caller's folder (paths resolve against it).
export function film(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", `src/film/${name}.ts`, ...args], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: cwd, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

export const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

// A PCM WAV (16-bit integer or 32-bit float), as mono floats in -1..1, with its format.
export function readWav(file: string): { rate: number; channels: number; bits: number; format: number; mono: Float64Array } {
  const data = readFileSync(file);
  assert.equal(data.toString("ascii", 0, 4), "RIFF", `${file} is not a RIFF file`);
  assert.equal(data.toString("ascii", 8, 12), "WAVE");
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let mono: Float64Array | null = null;
  while (at + 8 <= data.length) {
    const id = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = data.readUInt16LE(body);
      channels = data.readUInt16LE(body + 2);
      rate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
      if (format === 0xfffe) format = data.readUInt16LE(body + 24);
    } else if (id === "data") {
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, data.length - body) / (bytes * channels));
      mono = new Float64Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const offset = body + (f * channels + c) * bytes;
          sum += format === 3 ? data.readFloatLE(offset) : bits === 16 ? data.readInt16LE(offset) / 32768 : data.readInt32LE(offset) / 2147483648;
        }
        mono[f] = sum / channels;
      }
    }
    at = body + size + (size % 2);
  }
  assert.ok(mono, `${file} has no data chunk`);
  return { rate, channels, bits, format, mono };
}

// Mean square of the samples in [t0, t1) seconds.
export function power(samples: Float64Array, rate: number, t0: number, t1: number): number {
  const a = Math.max(0, Math.round(t0 * rate));
  const b = Math.min(samples.length, Math.round(t1 * rate));
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return b > a ? sum / (b - a) : 0;
}

export const db = (ratio: number) => 10 * Math.log10(ratio);

// The largest distance from each of `want` to the nearest of `got`.
export function worstMiss(want: number[], got: number[]): number {
  let worst = 0;
  for (const t of want) worst = Math.max(worst, Math.min(...got.map((g) => Math.abs(g - t))));
  return worst;
}
