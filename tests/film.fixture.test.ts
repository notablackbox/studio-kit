import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The synthetic song every later film test listens to: espeak-ng words at known offsets
// over a generated kick, snare and hat pattern whose tempo drifts from 120 to 123 BPM.

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-film-fixture-"));
  temps.push(dir);
  const result = spawnSync("python3", ["-I", "tests/fixtures/synth_song.py", "--out", dir], { cwd: kitRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return dir;
}

type Word = { i: number; word: string; display: string; line: number; section: number; start: number; end: number };
type Truth = {
  version: number;
  sample_rate: number;
  channels: number;
  samples: number;
  duration: number;
  tempo: { start_bpm: number; end_bpm: number; first_beat: number };
  beats: number[];
  downbeats: number[];
  kicks: number[];
  snares: number[];
  hats: number[];
  sections: { name: string; cue: string; start: number; end: number }[];
  lines: { text: string; display: string; section: number; words: [number, number] }[];
  words: Word[];
};

// A 16-bit PCM WAV: its format and its samples, interleaved.
function readWav(file: string) {
  const data = readFileSync(file);
  assert.equal(data.toString("ascii", 0, 4), "RIFF");
  assert.equal(data.toString("ascii", 8, 12), "WAVE");
  let at = 12;
  let format = { audioFormat: 0, channels: 0, rate: 0, bits: 0 };
  let samples: Int16Array | null = null;
  while (at + 8 <= data.length) {
    const id = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        rate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      samples = new Int16Array(data.buffer.slice(data.byteOffset + body, data.byteOffset + body + size));
    }
    at = body + size + (size % 2);
  }
  assert.ok(samples, "no data chunk");
  return { ...format, samples };
}

let dir = "";
let truth: Truth;
before(() => {
  dir = build();
  truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
});

test("the fixture writes the song, its two stems, the lyric sheet, the display text and the truth", () => {
  assert.deepEqual(readdirSync(dir).sort(), ["display.txt", "drums.wav", "lyrics.txt", "song.wav", "truth.json", "vocals.wav"]);
  assert.equal(truth.version, 1);
});

test("song.wav probes as 16-bit 44.1 kHz stereo of about 12 seconds, the length the truth gives", () => {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", join(dir, "song.wav")],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const parsed = JSON.parse(probe.stdout);
  assert.equal(parsed.streams[0].codec_name, "pcm_s16le");
  assert.equal(Number(parsed.streams[0].sample_rate), 44100);
  assert.equal(parsed.streams[0].channels, 2);
  const seconds = Number(parsed.format.duration);
  assert.ok(seconds > 11.5 && seconds < 12.5, String(seconds));
  assert.ok(Math.abs(seconds - truth.duration) < 1 / 44100 + 1e-6, `${seconds} vs ${truth.duration}`);
  assert.equal(truth.samples, Math.round(truth.duration * 44100));
});

test("the words are the lyric sheet's, in order, one display token each, inside their sections", () => {
  const lyricLines = readFileSync(join(dir, "lyrics.txt"), "utf8").split("\n").filter((l) => l.trim() !== "");
  const cues = lyricLines.filter((l) => /^\[.*\]$/.test(l.trim()));
  assert.equal(cues.length, 2, "two bracketed sections");
  const tokens = lyricLines.filter((l) => !/^\[.*\]$/.test(l.trim())).flatMap((l) => l.trim().split(/\s+/));
  const display = readFileSync(join(dir, "display.txt"), "utf8").split("\n").filter((l) => l.trim() !== "").flatMap((l) => l.trim().split(/\s+/));
  assert.ok(tokens.length >= 10 && tokens.length <= 14, `about twelve words, got ${tokens.length}`);
  assert.deepEqual(truth.words.map((w) => w.word), tokens);
  assert.deepEqual(truth.words.map((w) => w.display), display);
  for (const w of truth.words) assert.equal(w.display.toLowerCase().replace(/[^a-z']/g, ""), w.word);

  assert.deepEqual(truth.sections.map((s) => s.cue), cues.map((c) => c.trim()));
  assert.equal(truth.sections[0].start, 0);
  assert.equal(truth.sections.at(-1)!.end, truth.duration);
  for (let s = 1; s < truth.sections.length; s++) assert.equal(truth.sections[s].start, truth.sections[s - 1].end);

  let previousEnd = 0;
  truth.words.forEach((w, i) => {
    assert.equal(w.i, i);
    assert.ok(w.start >= previousEnd + 0.05, `word ${i} starts ${w.start}, the last ended ${previousEnd}`);
    assert.ok(w.end - w.start >= 0.08 && w.end - w.start <= 1.5, `word ${i} runs ${w.end - w.start}`);
    const section = truth.sections[w.section];
    assert.ok(w.start >= section.start && w.end <= section.end, `word ${i} outside its section`);
    previousEnd = w.end;
  });
  assert.ok(previousEnd < truth.duration);
  for (const line of truth.lines) {
    const [first, last] = line.words;
    assert.equal(line.text, truth.words.slice(first, last + 1).map((w) => w.word).join(" "));
  }
});

test("the beats drift from 120 to 123 BPM; kicks, snares and hats sit on the grid", () => {
  const { beats } = truth;
  assert.ok(beats.length >= 20, String(beats.length));
  assert.equal(beats[0], truth.tempo.first_beat);
  const gaps = beats.slice(1).map((t, i) => t - beats[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1] + 1.5 / 44100, `gap ${i} grows`);
  assert.ok(Math.abs(60 / gaps[0] - 120) < 0.5, `first ${60 / gaps[0]} BPM`);
  assert.ok(Math.abs(60 / gaps.at(-1)! - 123) < 0.5, `last ${60 / gaps.at(-1)!} BPM`);
  assert.ok(60 / gaps.at(-1)! - 60 / gaps[0] > 2, "the tempo drifts by about 3 BPM");

  assert.deepEqual(truth.downbeats, beats.filter((_, i) => i % 4 === 0));
  assert.deepEqual(truth.kicks, beats.filter((_, i) => i % 4 === 0 || i % 4 === 2));
  assert.deepEqual(truth.snares, beats.filter((_, i) => i % 4 === 1 || i % 4 === 3));
  assert.equal(truth.hats.length, beats.length - 1);
  truth.hats.forEach((t, i) => {
    assert.ok(Math.abs(t - (beats[i] + beats[i + 1]) / 2) < 0.002, `hat ${i} off the eighth`);
  });
});

test("the audio holds what the truth says: vocals only inside words, drums from the first beat, song = vocals + drums", () => {
  const song = readWav(join(dir, "song.wav"));
  const vocals = readWav(join(dir, "vocals.wav"));
  const drums = readWav(join(dir, "drums.wav"));
  for (const wav of [song, vocals, drums]) {
    assert.deepEqual([wav.audioFormat, wav.channels, wav.rate, wav.bits], [1, 2, 44100, 16]);
    assert.equal(wav.samples.length, truth.samples * 2);
  }
  for (let i = 0; i < song.samples.length; i++) {
    if (song.samples[i] !== vocals.samples[i] + drums.samples[i]) assert.fail(`sample ${i}: the song is not the sum of its stems`);
  }

  // Frame index of a time, as the fixture placed it.
  const frame = (t: number) => Math.round(t * 44100);
  const inWord = new Uint8Array(truth.samples);
  for (const w of truth.words) {
    inWord.fill(1, frame(w.start), frame(w.end));
    let peak = 0;
    for (let f = frame(w.start); f < frame(w.end); f++) peak = Math.max(peak, Math.abs(vocals.samples[2 * f]));
    assert.ok(peak > 3000, `word ${w.i} "${w.word}" peaks at ${peak}`);
    // The word's audio starts on its first sample and ends on its last.
    assert.notEqual(vocals.samples[2 * frame(w.start)], 0, `word ${w.i} starts late`);
    assert.notEqual(vocals.samples[2 * (frame(w.end) - 1)], 0, `word ${w.i} ends early`);
  }
  for (let f = 0; f < truth.samples; f++) {
    if (!inWord[f] && (vocals.samples[2 * f] !== 0 || vocals.samples[2 * f + 1] !== 0)) assert.fail(`vocal sound outside the words at ${f / 44100}`);
  }
  for (let f = 0; f < frame(truth.beats[0]); f++) {
    if (drums.samples[2 * f] !== 0) assert.fail(`drums before the first beat at ${f / 44100}`);
  }
  for (const t of [...truth.kicks, ...truth.snares, ...truth.hats]) {
    assert.notEqual(drums.samples[2 * frame(t)], 0, `no hit at ${t}`);
  }
});

test("the fixture is deterministic: a second build is byte for byte the same", () => {
  const again = build();
  for (const name of readdirSync(dir)) {
    const a = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(again, name))).digest("hex");
    assert.equal(a, b, name);
  }
});
