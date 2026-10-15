import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  Failed,
  Refused,
  Unexpected,
  fromCaller,
  isMain,
  outProblem,
  parseFlags,
  refuseReportPaths,
  requireFile,
  run,
  shown,
  writeIn,
  writeReport,
} from "./lib/cli.ts";
import type { RunResult } from "../render.ts";

// film:window: the clean vocal window for a sung clip (claudia.gallery's toolkit wiki, item
// 14). The vocal stem is cut at [song_t0, song_t0 + duration]: --song-t0 is the shot's start
// and --duration the clip's, both in song time, so the file's first sample is song time
// song_t0 (the clip's `song_t0`, which film:edl and film:sync read). The phrase's words are
// --from to --to, or, without them, the words that start inside
// [song_t0 - 0.02, song_t0 + duration - 0.08); they must lie inside the window, which must
// start in a word gap and end in one (else exit 2, naming the word). Words are merged into
// phrases across gaps of 0.35 s or less; each phrase is kept from 0.05 s before its first word
// (never before the window or the word ahead) to its last word's end plus a release tail that
// follows the stem's 10 ms energy until it falls 24 dB under the phrase's peak (at least the
// 15 ms of the fade, at most 0.40 s, never past the next word's start less 0.05 s nor the
// window's end); 15 ms raised-cosine ramps on every gate edge and silence elsewhere. The kept
// part is normalised to -16 dBFS RMS and limited to -1 dBFS peaks, and written as <name>.wav
// (16-bit, 44.1 kHz, mono) and <name>.mp3 (192 kbps). A kept part under -60 dBFS RMS before
// normalising (a silent stem) fails, exit 3, the report written and no audio. A duration under
// 4 s or over 8 s is refused; --allow-short (for tests only) lifts the lower bound. A window
// reaching past the decoded stem's end (1 ms slack) is refused, never zero-filled.

const COMMAND = "film:window";
const RATE = 44100;
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const LEAD = 0.05;
const START_SLACK = 0.02; // a derived word may start this much before the window ...
const END_SLACK = 0.08; // ... and must start this much before its end
const EPS = 1e-6;
const MERGE_GAP = 0.35;
const TAIL_MAX = 0.4;
const TAIL_DB = 24;
const RAMP = 0.015;
const TARGET_DBFS = -16;
const LIMIT_DBFS = -1.05; // a little under -1 dBFS, so 16-bit rounding never crosses it
const SILENT_DBFS = -60; // a kept part quieter than this before normalising is silence
const SILENT_RMS = 10 ** (SILENT_DBFS / 20);
const MIN_S = 4;
const MAX_S = 8;
const END_ROUNDING = 0.001; // a window may end this far past the stem's last sample

type Word = { i: number; w: string; t0: number; t1: number };

const dbfs = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

function readWords(file: string): Word[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const words = data?.words;
    if (!Array.isArray(words) || words.length === 0) throw new Error("no words");
    return words.map((w: Record<string, unknown>, i: number) => {
      const t0 = Number(w.t0);
      const t1 = Number(w.t1);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0 || t0 < 0) throw new Error("bad word");
      return { i, w: String(w.w ?? ""), t0, t1 };
    });
  } catch {
    throw new Refused(["--words is not a words.json"]);
  }
}

async function tool(command: string, args: string[]): Promise<RunResult> {
  const { runProcess } = await import("../render.ts");
  const result = await runProcess(command, args, { timeoutMs: TOOL_TIMEOUT_MS });
  if (result.failure) throw new Unexpected(result.failure);
  if (result.timedOut) throw new Unexpected(`${command} took longer than ${TOOL_TIMEOUT_MS / 60000} minutes`);
  return result;
}

// The stem as mono floats at 44.1 kHz, decoded by ffmpeg into the temp folder.
async function decode(file: string, temp: string): Promise<Float32Array> {
  const probe = await tool("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
  if (probe.status !== 0 || probe.stdout.trim() !== "audio") throw new Refused(["--vocals cannot be read as audio"]);
  const raw = join(temp, "vocals.f32");
  const result = await tool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
  if (result.status !== 0) throw new Refused(["--vocals cannot be read as audio"]);
  const bytes = readFileSync(raw);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

// RMS per 10 ms frame (frame k covers [k, k+1) x 10 ms).
function frames10(samples: Float32Array): Float64Array {
  const size = Math.round(0.01 * RATE);
  const out = new Float64Array(Math.ceil(samples.length / size));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    const end = Math.min(samples.length, (k + 1) * size);
    for (let i = k * size; i < end; i++) sum += samples[i] * samples[i];
    out[k] = Math.sqrt(sum / Math.max(1, end - k * size));
  }
  return out;
}

type Phrase = { first: number; last: number; t0: number; t1: number; tail: number };

function phrases(words: Word[], from: number, to: number, energy: Float64Array, windowStart: number, windowEnd: number): Phrase[] {
  const groups: [number, number][] = [];
  for (let i = from; i <= to; i++) {
    if (groups.length > 0 && words[i].t0 - words[i - 1].t1 <= MERGE_GAP) groups.at(-1)![1] = i;
    else groups.push([i, i]);
  }
  const result: Phrase[] = [];
  for (const [first, last] of groups) {
    const t0 = Math.max(result.length ? result.at(-1)!.t1 : windowStart, words[first].t0 - LEAD);
    const end = words[last].t1;
    let peak = 0;
    for (let k = Math.floor(words[first].t0 / 0.01); k < Math.ceil(end / 0.01) && k < energy.length; k++) peak = Math.max(peak, energy[k]);
    const floor = peak * 10 ** (-TAIL_DB / 20);
    const next = last + 1 < words.length ? words[last + 1].t0 - LEAD : Infinity;
    const limit = Math.max(end, Math.min(end + TAIL_MAX, next, windowEnd));
    let t1 = end;
    for (let k = Math.ceil(end / 0.01); k < energy.length && (k + 1) * 0.01 <= limit; k++) {
      if (energy[k] < floor) break;
      t1 = (k + 1) * 0.01;
    }
    // At least one ramp long, so the fade-out sits after the word, never on it.
    t1 = Math.min(Math.max(t1, end + RAMP), limit);
    result.push({ first, last, t0, t1, tail: t1 - end });
  }
  return result;
}

// The window's samples: the gated phrases, normalised and limited.
// `source` is the kept part's RMS before normalising: the stem's own level there.
function render(samples: Float32Array, t0: number, length: number, gates: Phrase[]): { pcm: Int16Array; rms: number; peak: number; source: number } {
  const n = Math.round(length * RATE);
  const start = Math.round(t0 * RATE);
  const x = new Float64Array(n);
  const kept = new Uint8Array(n);
  const ramp = Math.round(RAMP * RATE);
  for (const g of gates) {
    const a = Math.max(0, Math.round(g.t0 * RATE) - start);
    const b = Math.min(n, Math.round(g.t1 * RATE) - start);
    for (let i = a; i < b; i++) {
      const fromEdge = Math.min(i - a, b - 1 - i);
      const gain = fromEdge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (fromEdge + 0.5)) / ramp);
      x[i] = (samples[start + i] ?? 0) * gain;
      kept[i] = 1;
    }
  }
  const target = 10 ** (TARGET_DBFS / 20);
  const limit = 10 ** (LIMIT_DBFS / 20);
  const rmsOf = () => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (kept[i]) {
        sum += x[i] * x[i];
        count++;
      }
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const hold = Math.round(0.005 * RATE);
  const source = rmsOf();
  // A silent kept part is not normalised (film:window fails it before writing anything).
  for (let round = 0; round < 40 && source >= SILENT_RMS; round++) {
    const rms = rmsOf();
    if (rms <= 0) break;
    const scale = target / rms;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      x[i] *= scale;
      peak = Math.max(peak, Math.abs(x[i]));
    }
    if (peak <= limit) break;
    // Gain reduction around every peak over the limit: the lowest gain within 5 ms either side,
    // so the limiter eases in and out instead of clipping.
    const need = new Float64Array(n).fill(1);
    for (let i = 0; i < n; i++) if (Math.abs(x[i]) > limit) need[i] = limit / Math.abs(x[i]);
    const gain = new Float64Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      if (need[i] < 1) {
        for (let j = Math.max(0, i - hold); j < Math.min(n, i + hold + 1); j++) {
          const shaped = need[i] + (1 - need[i]) * (Math.abs(j - i) / (hold + 1));
          if (shaped < gain[j]) gain[j] = shaped;
        }
      }
    }
    for (let i = 0; i < n; i++) x[i] *= gain[i];
  }
  const pcm = new Int16Array(n);
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-limit, Math.min(limit, x[i]));
    pcm[i] = Math.round(v * 32767);
    const q = pcm[i] / 32768;
    peak = Math.max(peak, Math.abs(q));
    if (kept[i]) {
      sum += q * q;
      count++;
    }
  }
  return { pcm, rms: Math.sqrt(sum / Math.max(1, count)), peak, source };
}

function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    vocals: { type: "string" },
    words: { type: "string" },
    out: { type: "string" },
    "song-t0": { type: "string" },
    duration: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    name: { type: "string" },
    "allow-short": { type: "boolean" },
  });
  if (!values.vocals || !values.words || !values.out || values["song-t0"] === undefined || values.duration === undefined) {
    throw new Refused([`${COMMAND}: --vocals <path>, --words <path>, --out <dir>, --song-t0 <s> and --duration <s> are required`]);
  }
  const seconds = (flag: string, value: string, ok: (n: number) => boolean, want: string) => {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n) || !ok(n)) throw new Refused([`${flag} is ${shown(value)}, want ${want}`]);
    return n;
  };
  const songT0 = seconds("--song-t0", values["song-t0"], (n) => n >= 0, "seconds from 0");
  const duration = seconds("--duration", values.duration, (n) => n > 0, "seconds above 0");
  if ((values.from === undefined) !== (values.to === undefined)) throw new Refused(["--from and --to go together"]);
  const given = values.from !== undefined && values.to !== undefined;
  if (given && (!/^\d+$/.test(values.from!) || !/^\d+$/.test(values.to!) || Number(values.from) > Number(values.to))) {
    throw new Refused(["--from and --to want word indices, --from no later than --to"]);
  }
  if (values.name !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(values.name)) throw new Refused(["--name wants letters, digits, - and _"]);
  const allowShort = values["allow-short"] === true;
  if (duration > MAX_S + EPS || (duration < MIN_S - EPS && !allowShort)) throw new Refused([`--duration is ${duration.toFixed(2)} s, want 4 to 8 s`]);
  const vocals = requireFile(fromCaller(values.vocals), "--vocals");
  const wordsFile = requireFile(fromCaller(values.words), "--words");
  const words = readWords(wordsFile);
  if (given && Number(values.to) >= words.length) throw new Refused([`--to ${values.to} is past the last word (${words.length - 1})`]);

  // The window, in song time: it starts and ends in word gaps, and holds the phrase's words.
  const windowEnd = songT0 + duration;
  const span = (w: Word) => `${w.i} ${shown(w.w)} (${w.t0.toFixed(2)} to ${w.t1.toFixed(2)})`;
  const inside = (t: number) => words.find((w) => t > w.t0 + EPS && t < w.t1 - EPS);
  const atStart = inside(songT0);
  const atEnd = inside(windowEnd);
  const edges: string[] = [];
  if (atStart) edges.push(`the window starts at ${songT0.toFixed(2)} s inside word ${span(atStart)}: start it in a word gap`);
  if (atEnd) edges.push(`the window ends at ${windowEnd.toFixed(2)} s inside word ${span(atEnd)}: end it in a word gap`);
  if (edges.length > 0) throw new Refused(edges);
  const where = `(${songT0.toFixed(2)} to ${windowEnd.toFixed(2)} s)`;
  let from: number;
  let to: number;
  if (given) {
    from = Number(values.from);
    to = Number(values.to);
    const outside = words.slice(from, to + 1).filter((w) => w.t0 < songT0 - EPS || w.t1 > windowEnd + EPS);
    if (outside.length > 0) throw new Refused(outside.map((w) => `word ${span(w)} is outside the window ${where}`));
  } else {
    const starting = words.filter((w) => w.t0 >= songT0 - START_SLACK - EPS && w.t0 < windowEnd - END_SLACK - EPS);
    if (starting.length === 0) throw new Refused([`no word starts inside the window ${where}`]);
    from = starting[0].i;
    to = starting.at(-1)!.i;
  }
  const name = values.name ?? `window-${from}-${to}`;
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  refuseReportPaths(out, "window", [["--vocals", vocals], ["--words", wordsFile]]);

  const temp = mkdtempSync(join(tmpdir(), "studio-kit-window-"));
  try {
    const samples = await decode(vocals, temp);
    // The window lies inside the stem: past its end there are no samples to cut (they would be
    // silence made up), so it is refused, with a millisecond's slack for rounding.
    const stemEnd = samples.length / RATE;
    if (windowEnd > stemEnd + END_ROUNDING) {
      throw new Refused([`the window ends at ${windowEnd.toFixed(3)} s, past the end of --vocals at ${stemEnd.toFixed(3)} s`]);
    }
    const energy = frames10(samples);
    // A phrase never starts before the window, nor before the end of the word ahead.
    const windowStart = Math.max(songT0, from > 0 ? words[from - 1].t1 : 0);
    const gates = phrases(words, from, to, energy, windowStart, windowEnd);
    const t0 = gates[0].t0;
    const t1 = gates.at(-1)!.t1;
    const { pcm, rms, peak, source } = render(samples, songT0, duration, gates);
    const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
    const inputs = { vocals, words: wordsFile, song_t0: songT0, duration, from: given ? from : null, to: given ? to : null, allow_short: allowShort };
    if (source < SILENT_RMS) {
      // A silent stem (or a silent stretch of it): normalising would only lift the noise floor,
      // and a silent window would pass to the clip as if she sang. Checked and failed.
      const level = source > 0 ? `${dbfs(source).toFixed(1)} dBFS` : "-inf dBFS";
      // No audio on a failed run: an earlier run's window of the same name is removed.
      rmSync(join(out, `${name}.wav`), { force: true });
      rmSync(join(out, `${name}.mp3`), { force: true });
      writeReport(out, "window", {
        ok: false,
        inputs,
        outputs: { report: "window-report.json" },
        song_t0: songT0,
        duration,
        from,
        to,
        phrases: gates.map((g) => ({ t0: r(g.t0), t1: r(g.t1), words: [g.first, g.last] })),
        words: words.slice(from, to + 1),
        rms_dbfs: source > 0 ? r(dbfs(source), 2) : null,
        silent_below_dbfs: SILENT_DBFS,
      });
      throw new Failed([`window: the kept phrases are silent (${level} RMS, want at least ${SILENT_DBFS} dBFS)`]);
    }
    const wavBytes = wav(pcm);
    writeFileSync(join(temp, "window.wav"), wavBytes);
    const mp3 = join(temp, "window.mp3");
    const encoded = await tool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", join(temp, "window.wav"), "-c:a", "libmp3lame", "-b:a", "192k", mp3]);
    if (encoded.status !== 0) throw new Unexpected("ffmpeg could not encode the MP3");
    const mp3Bytes = readFileSync(mp3);

    writeIn(out, `${name}.wav`, wavBytes);
    writeIn(out, `${name}.mp3`, mp3Bytes);
    writeReport(out, "window", {
      ok: true,
      inputs,
      outputs: { wav: `${name}.wav`, mp3: `${name}.mp3`, report: "window-report.json" },
      // The file is [song_t0, song_t0 + duration] of the song; the voice in it runs t0 to t1.
      song_t0: songT0,
      duration,
      from,
      to,
      t0: r(t0),
      t1: r(t1),
      tail: r(gates.at(-1)!.tail),
      phrases: gates.map((g) => ({ t0: r(g.t0), t1: r(g.t1), words: [g.first, g.last] })),
      words: words.slice(from, to + 1),
      rms_dbfs: r(dbfs(rms), 2),
      peak_dbfs: r(dbfs(peak), 2),
      format: { wav: "16-bit PCM, 44.1 kHz, mono", mp3: "192 kbps" },
    });
    console.log(
      `window: ${name}, words ${from} to ${to}, song ${songT0.toFixed(2)} to ${windowEnd.toFixed(2)} s (${duration.toFixed(2)} s), voice ${t0.toFixed(2)} to ${t1.toFixed(2)} s, ${dbfs(rms).toFixed(1)} dBFS RMS, peak ${dbfs(peak).toFixed(1)} dBFS`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
