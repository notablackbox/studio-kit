import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, readWav, song, truthWords, type Truth } from "./fixtures/film.ts";

// film:window cuts the clean vocal window for a sung clip (toolkit item 14): the vocal stem
// from the shot's start (`--song-t0`) for the clip's duration, so the file's first sample is
// song time song_t0. Only the phrase's words are kept, each phrase from 0.05 s before its first
// word to a short release tail, -16 dBFS RMS with peaks at or under -1 dBFS, silence elsewhere,
// as a WAV and a 192 kbps MP3. The window starts in a word gap and ends in one.

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
  truthWords(truth, join(dir, "words.json"));
});

const dbfs = (x: number) => 20 * Math.log10(x);
const r4 = (x: number) => Math.round(x * 10000) / 10000;

test("a window from the shot's start: words 0 to 6, the file's first sample at song_t0", () => {
  // Words 0 to 6: "the city wakes we count the windows". The shot starts 0.024 s before the
  // first word and runs 5 s, ending in the gap before word 7.
  const t0 = r4(truth.words[0].start - 0.024);
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(t0), "--duration", "5", "--from", "0", "--to", "6", "--name", "W01", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(readFileSync(join(dir, "a", "window-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { vocals: join(dir, "vocals.wav"), words: join(dir, "words.json"), song_t0: t0, duration: 5, from: 0, to: 6, allow_short: false });
  assert.deepEqual(report.outputs, { wav: "W01.wav", mp3: "W01.mp3", report: "window-report.json" });
  assert.equal(report.song_t0, t0);
  assert.equal(report.duration, 5);
  assert.deepEqual([report.from, report.to], [0, 6]);
  const first = truth.words[0];
  const last = truth.words[6];
  // The voice: from the window's start (never before it) to the last word's release tail.
  assert.ok(report.t0 >= t0 - 1e-6 && report.t0 <= first.start, `t0 ${report.t0}`);
  assert.ok(report.t1 > last.end && report.t1 - last.end <= 0.4 + 1e-6, `tail ${report.t1 - last.end}`);
  assert.ok(report.t1 <= truth.words[7].start - 0.05, "ends in the gap before the next word");
  assert.ok(report.t1 <= t0 + 5 + 1e-6);
  assert.deepEqual(report.words.map((w: { w: string }) => w.w), truth.words.slice(0, 7).map((w) => w.word));

  const wav = readWav(join(dir, "a", "W01.wav"));
  assert.deepEqual([wav.format, wav.rate, wav.channels, wav.bits], [1, 44100, 1, 16]);
  // The file is the clip's duration: sample k is song time song_t0 + k / 44100.
  assert.equal(wav.mono.length, 5 * 44100);
  // The RMS of the kept part: the phrases' gates, as the report gives them.
  let peak = 0;
  let sum = 0;
  let kept = 0;
  for (const v of wav.mono) peak = Math.max(peak, Math.abs(v));
  for (const gate of report.phrases as { t0: number; t1: number }[]) {
    assert.ok(gate.t0 >= report.t0 - 1e-6 && gate.t1 <= report.t1 + 1e-6);
    for (let i = Math.round((gate.t0 - t0) * 44100); i < Math.round((gate.t1 - t0) * 44100) && i < wav.mono.length; i++) {
      sum += wav.mono[i] * wav.mono[i];
      kept++;
    }
  }
  const rms = Math.sqrt(sum / kept);
  assert.ok(dbfs(peak) <= -1 + 1e-3, `peak ${dbfs(peak).toFixed(2)} dBFS`);
  assert.ok(Math.abs(dbfs(rms) - -16) <= 0.5, `rms ${dbfs(rms).toFixed(2)} dBFS`);
  assert.ok(Math.abs(report.rms_dbfs - dbfs(rms)) <= 0.1);
  assert.ok(Math.abs(report.peak_dbfs - dbfs(peak)) <= 0.1);
  // The first word sits where the song has it: the file's loud part starts at its start.
  const onset = wav.mono.findIndex((v) => Math.abs(v) > 0.01) / 44100;
  assert.ok(Math.abs(t0 + onset - first.start) <= 0.06, `voice at ${(t0 + onset).toFixed(3)}, the word at ${first.start}`);
  // The gap between the two lines (over 0.35 s, so two phrases) is gated to silence after the
  // first phrase's tail.
  let silent = 0;
  for (let i = Math.ceil((truth.words[2].end - t0) * 44100); i < (truth.words[3].start - t0) * 44100; i++) {
    if (wav.mono[i] === 0) silent++;
  }
  assert.ok(silent / 44100 >= 0.1, `only ${(silent / 44100).toFixed(3)} s of silence between the lines`);
  // After the last phrase's tail, silence to the end of the file.
  assert.ok(wav.mono.subarray(Math.ceil((report.t1 - t0) * 44100) + 1).every((v) => v === 0));

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate", "-of", "json", join(dir, "a", "W01.mp3")], { encoding: "utf8" });
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.codec_name, "mp3");
  assert.equal(Number(stream.sample_rate), 44100);
  assert.equal(Number(stream.bit_rate), 192000);
  assert.match(lines(result.stdout)[0], /^window: W01, words 0 to 6, song \d+\.\d\d to \d+\.\d\d s \(5\.00 s\), voice \d+\.\d\d to \d+\.\d\d s, -16\.\d dBFS RMS, peak -\d+\.\d dBFS$/);
});

test("a window cut on a beat before the first word: the words derived from the span, the voice in place", () => {
  // The shot starts on the last beat at least 0.3 s before the first word, in the silence
  // before the singer; the clip runs 5 s.
  const beat = r4(truth.beats.filter((b) => b < truth.words[0].start - 0.3).at(-1)!);
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(beat), "--duration", "5", "--out", "beat"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "beat", "window-report.json"), "utf8"));
  assert.equal(report.song_t0, beat);
  // The words are those that start inside the window: 0 to 6 (word 7 starts after its end).
  assert.deepEqual([report.from, report.to], [0, 6]);
  assert.deepEqual(report.inputs.from, null);
  // The voice starts 0.05 s before the first word, well after the window's start.
  assert.ok(Math.abs(report.t0 - (truth.words[0].start - 0.05)) <= 1e-3, `t0 ${report.t0}`);
  const wav = readWav(join(dir, "beat", "window-0-6.wav"));
  assert.equal(wav.mono.length, 5 * 44100);
  // Silence from the beat to the voice: the window is not moved to the voice.
  const lead = Math.floor((report.t0 - beat) * 44100);
  assert.ok(lead > 0.2 * 44100);
  assert.ok(wav.mono.subarray(0, lead).every((v) => v === 0), "silent before the first phrase");
  const onset = wav.mono.findIndex((v) => Math.abs(v) > 0.01) / 44100;
  assert.ok(Math.abs(beat + onset - truth.words[0].start) <= 0.06, `voice at ${(beat + onset).toFixed(3)}, the word at ${truth.words[0].start}`);
});

test("a window that starts or ends inside a word, or leaves a phrase's word outside, is refused naming the word", () => {
  const w = truth.words;
  const span = (i: number) => `(${w[i].start.toFixed(2)} to ${w[i].end.toFixed(2)})`;
  const inStart = r4((w[0].start + w[0].end) / 2);
  const start = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(inStart), "--duration", "5", "--out", "x"]);
  assert.equal(start.status, 2, start.stdout + start.stderr);
  assert.deepEqual(lines(start.stdout), [`the window starts at ${inStart.toFixed(2)} s inside word 0 "the" ${span(0)}: start it in a word gap`]);

  // Ends inside word 6 ("windows").
  const t0 = r4(w[0].start - 0.024);
  const length = r4((w[6].start + w[6].end) / 2 - t0);
  const end = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(t0), "--duration", String(length), "--out", "x"]);
  assert.equal(end.status, 2, end.stdout + end.stderr);
  assert.deepEqual(lines(end.stdout), [`the window ends at ${(t0 + length).toFixed(2)} s inside word 6 "windows" ${span(6)}: end it in a word gap`]);

  // A word of --from/--to outside the window.
  const late = r4(w[2].end + 0.1);
  const outside = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(late), "--duration", "4", "--from", "0", "--to", "6", "--out", "x"]);
  assert.equal(outside.status, 2, outside.stdout + outside.stderr);
  assert.deepEqual(lines(outside.stdout), [
    `word 0 "the" ${span(0)} is outside the window (${late.toFixed(2)} to ${(late + 4).toFixed(2)} s)`,
    `word 1 "city" ${span(1)} is outside the window (${late.toFixed(2)} to ${(late + 4).toFixed(2)} s)`,
    `word 2 "wakes" ${span(2)} is outside the window (${late.toFixed(2)} to ${(late + 4).toFixed(2)} s)`,
  ]);
  assert.equal(existsSync(join(dir, "x")), false);
});

test("a duration under 4 s or over 8 s is refused with its length", () => {
  const t0 = String(r4(truth.words[7].start - 0.05));
  const short = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", t0, "--duration", "1.4", "--out", "x"]);
  assert.equal(short.status, 2, short.stdout + short.stderr);
  assert.deepEqual(lines(short.stdout), ["--duration is 1.40 s, want 4 to 8 s"]);
  assert.equal(existsSync(join(dir, "x")), false);

  const long = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", "0", "--duration", "9", "--out", "x"]);
  assert.equal(long.status, 2, long.stdout + long.stderr);
  assert.deepEqual(lines(long.stdout), ["--duration is 9.00 s, want 4 to 8 s"]);
  assert.equal(existsSync(join(dir, "x")), false);
});

test("--allow-short (tests only) cuts a short phrase with the same tail and loudness rules", () => {
  // Words 7 and 8, "hold on": the window ends in the gap before word 9.
  const t0 = r4(truth.words[7].start - 0.05);
  const length = r4((truth.words[8].end + truth.words[9].start) / 2 - t0);
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", String(t0), "--duration", String(length), "--from", "7", "--to", "8", "--out", "b", "--allow-short"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "b", "window-report.json"), "utf8"));
  assert.ok(report.duration < 4);
  assert.ok(report.t1 - truth.words[8].end <= 0.4 + 1e-6);
  assert.ok(report.t1 <= t0 + length + 1e-6, "the tail stops at the window's end");
  assert.ok(Math.abs(report.rms_dbfs - -16) <= 0.5);
  assert.ok(report.peak_dbfs <= -1 + 1e-3);
  // The default name: the word range.
  assert.ok(existsSync(join(dir, "b", "window-7-8.wav")) && existsSync(join(dir, "b", "window-7-8.mp3")));
});

test("a window cut from a silent stem fails: exit 3, one line, the report written, no audio", () => {
  // The stem's length and format, every sample zero.
  const silent = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "vocals.wav"), "-af", "volume=0", join(dir, "silent.wav")]);
  assert.equal(silent.status, 0, String(silent.stderr));
  const t0 = String(r4(truth.words[0].start - 0.024));
  const result = film("window", dir, ["--vocals", "silent.wav", "--words", "words.json", "--song-t0", t0, "--duration", "5", "--from", "0", "--to", "6", "--name", "W09", "--out", "quiet"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(lines(result.stdout), ["window: the kept phrases are silent (-inf dBFS RMS, want at least -60 dBFS)"]);
  const report = JSON.parse(readFileSync(join(dir, "quiet", "window-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.rms_dbfs, null);
  assert.deepEqual(report.outputs, { report: "window-report.json" });
  assert.equal(existsSync(join(dir, "quiet", "W09.wav")), false);
  assert.equal(existsSync(join(dir, "quiet", "W09.mp3")), false);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "noise.wav"), "not audio");
  writeFileSync(join(dir, "bad.json"), "[1, 2]");
  const t0 = String(r4(truth.words[0].start - 0.024));
  const base = ["--vocals", "vocals.wav", "--words", "words.json", "--out", "x", "--song-t0", t0, "--duration", "5"];
  const cases: [string[], string][] = [
    [["--vocals", "vocals.wav", "--words", "words.json", "--out", "x", "--from", "0", "--to", "6"], "film:window: --vocals <path>, --words <path>, --out <dir>, --song-t0 <s> and --duration <s> are required"],
    [[...base, "--from", "3", "--to", "1"], "--from and --to want word indices, --from no later than --to"],
    [[...base, "--from", "a", "--to", "1"], "--from and --to want word indices, --from no later than --to"],
    [[...base, "--from", "3"], "--from and --to go together"],
    [[...base, "--from", "0", "--to", "12"], "--to 12 is past the last word (11)"],
    [[...base, "--name", "../up"], "--name wants letters, digits, - and _"],
    [["--vocals", "vocals.wav", "--words", "words.json", "--out", "x", "--song-t0", "soon", "--duration", "5"], '--song-t0 is "soon", want seconds from 0'],
    [["--vocals", "vocals.wav", "--words", "words.json", "--out", "x", "--song-t0", t0, "--duration", "0"], '--duration is "0", want seconds above 0'],
    [["--vocals", "vocals.wav", "--words", "words.json", "--out", "x", "--song-t0", "10.6", "--duration", "5"], "no word starts inside the window (10.60 to 15.60 s)"],
    [["--vocals", "nope.wav", "--words", "words.json", "--out", "x", "--song-t0", t0, "--duration", "5"], "--vocals cannot be read"],
    [["--vocals", "noise.wav", "--words", "words.json", "--out", "x", "--song-t0", t0, "--duration", "5"], "--vocals cannot be read as audio"],
    [["--vocals", "vocals.wav", "--words", "bad.json", "--out", "x", "--song-t0", t0, "--duration", "5"], "--words is not a words.json"],
  ];
  for (const [args, line] of cases) {
    const result = film("window", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  // No ffmpeg or ffprobe on the path.
  const t0 = String(r4(truth.words[0].start - 0.024));
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--song-t0", t0, "--duration", "5", "--out", "y"], { PATH: "/nonexistent" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:window: ffprobe could not be started"]);
  assert.equal(existsSync(join(dir, "y")), false);
});
