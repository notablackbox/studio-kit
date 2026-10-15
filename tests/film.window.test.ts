import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, readWav, song, truthWords, type Truth } from "./fixtures/film.ts";

// film:window cuts one phrase of the vocal stem by word indices, for a sung clip's audio
// reference: from the gap before the first word to the gap after the last, a short release
// tail, -16 dBFS RMS with peaks at or under -1 dBFS, as a WAV and a 192 kbps MP3.

let dir = "";
let truth: Truth;
before(() => {
  ({ dir, truth } = song());
  truthWords(truth, join(dir, "words.json"));
});

const dbfs = (x: number) => 20 * Math.log10(x);

test("a phrase of the right length and loudness, starting and ending in word gaps", () => {
  // Words 0 to 6: "the city wakes we count the windows", about 4.4 s.
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--from", "0", "--to", "6", "--name", "W01", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(readFileSync(join(dir, "a", "window-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { vocals: join(dir, "vocals.wav"), words: join(dir, "words.json"), from: 0, to: 6, allow_short: false });
  assert.deepEqual(report.outputs, { wav: "W01.wav", mp3: "W01.mp3", report: "window-report.json" });
  const first = truth.words[0];
  const last = truth.words[6];
  assert.ok(report.t0 <= first.start && report.t0 >= first.start - 0.06, `t0 ${report.t0}`);
  assert.ok(report.t1 > last.end && report.t1 - last.end <= 0.4 + 1e-6, `tail ${report.t1 - last.end}`);
  assert.ok(report.t1 <= truth.words[7].start - 0.05, "ends in the gap before the next word");
  assert.deepEqual(report.words.map((w: { w: string }) => w.w), truth.words.slice(0, 7).map((w) => w.word));
  // The length is the window's own, rounded once (not the difference of two rounded times).
  assert.equal(report.length, Number(report.length.toFixed(4)));
  assert.ok(Math.abs(report.length - (report.t1 - report.t0)) <= 1.5e-4);
  assert.ok(report.length >= 4 && report.length <= 8);

  const wav = readWav(join(dir, "a", "W01.wav"));
  assert.deepEqual([wav.format, wav.rate, wav.channels, wav.bits], [1, 44100, 1, 16]);
  assert.ok(Math.abs(wav.mono.length / 44100 - report.length) < 0.002, `${wav.mono.length / 44100} vs ${report.length}`);
  // The RMS of the kept part: the phrases' gates, as the report gives them.
  let peak = 0;
  let sum = 0;
  let kept = 0;
  for (const v of wav.mono) peak = Math.max(peak, Math.abs(v));
  for (const gate of report.phrases as { t0: number; t1: number }[]) {
    assert.ok(gate.t0 >= report.t0 - 1e-6 && gate.t1 <= report.t1 + 1e-6);
    for (let i = Math.round((gate.t0 - report.t0) * 44100); i < Math.round((gate.t1 - report.t0) * 44100) && i < wav.mono.length; i++) {
      sum += wav.mono[i] * wav.mono[i];
      kept++;
    }
  }
  const rms = Math.sqrt(sum / kept);
  assert.ok(dbfs(peak) <= -1 + 1e-3, `peak ${dbfs(peak).toFixed(2)} dBFS`);
  assert.ok(Math.abs(dbfs(rms) - -16) <= 0.5, `rms ${dbfs(rms).toFixed(2)} dBFS`);
  assert.ok(Math.abs(report.rms_dbfs - dbfs(rms)) <= 0.1);
  assert.ok(Math.abs(report.peak_dbfs - dbfs(peak)) <= 0.1);
  // The gap between the two lines (over 0.35 s, so two phrases) is gated to silence after the
  // first phrase's tail.
  let silent = 0;
  for (let i = Math.ceil((truth.words[2].end - report.t0) * 44100); i < (truth.words[3].start - report.t0) * 44100; i++) {
    if (wav.mono[i] === 0) silent++;
  }
  assert.ok(silent / 44100 >= 0.1, `only ${(silent / 44100).toFixed(3)} s of silence between the lines`);

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate", "-of", "json", join(dir, "a", "W01.mp3")], { encoding: "utf8" });
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.codec_name, "mp3");
  assert.equal(Number(stream.sample_rate), 44100);
  assert.equal(Number(stream.bit_rate), 192000);
  assert.match(lines(result.stdout)[0], /^window: W01, words 0 to 6, \d+\.\d\d to \d+\.\d\d s \(\d\.\d\d s\), -16\.\d dBFS RMS, peak -\d+\.\d dBFS$/);
});

test("a window shorter than 4 s or longer than 8 s is refused with its length", () => {
  const short = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--from", "7", "--to", "8", "--out", "x"]);
  assert.equal(short.status, 2, short.stdout + short.stderr);
  assert.match(lines(short.stdout)[0], /^window is \d\.\d\d s \(\d+\.\d\d to \d+\.\d\d\), want 4 to 8 s$/);
  assert.equal(lines(short.stdout).length, 1);
  assert.equal(existsSync(join(dir, "x")), false);

  const long = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--from", "0", "--to", "11", "--out", "x"]);
  assert.equal(long.status, 2, long.stdout + long.stderr);
  assert.match(lines(long.stdout)[0], /^window is \d\.\d\d s \(\d+\.\d\d to \d+\.\d\d\), want 4 to 8 s$/);
  assert.equal(existsSync(join(dir, "x")), false);
});

test("--allow-short (tests only) cuts a short phrase with the same tail and loudness rules", () => {
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--from", "7", "--to", "8", "--out", "b", "--allow-short"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "b", "window-report.json"), "utf8"));
  assert.ok(report.length < 4);
  assert.ok(report.t1 - truth.words[8].end <= 0.4 + 1e-6);
  assert.ok(Math.abs(report.rms_dbfs - -16) <= 0.5);
  assert.ok(report.peak_dbfs <= -1 + 1e-3);
  // The default name: the word range.
  assert.ok(existsSync(join(dir, "b", "window-7-8.wav")) && existsSync(join(dir, "b", "window-7-8.mp3")));
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "noise.wav"), "not audio");
  writeFileSync(join(dir, "bad.json"), "[1, 2]");
  const base = ["--vocals", "vocals.wav", "--words", "words.json", "--out", "x"];
  const cases: [string[], string][] = [
    [["--vocals", "vocals.wav", "--words", "words.json", "--out", "x"], "film:window: --vocals <path>, --words <path>, --out <dir>, --from <word> and --to <word> are required"],
    [[...base, "--from", "3", "--to", "1"], "--from and --to want word indices, --from no later than --to"],
    [[...base, "--from", "a", "--to", "1"], "--from and --to want word indices, --from no later than --to"],
    [[...base, "--from", "0", "--to", "12"], "--to 12 is past the last word (11)"],
    [[...base, "--from", "0", "--to", "6", "--name", "../up"], "--name wants letters, digits, - and _"],
    [["--vocals", "nope.wav", "--words", "words.json", "--out", "x", "--from", "0", "--to", "6"], "--vocals cannot be read"],
    [["--vocals", "noise.wav", "--words", "words.json", "--out", "x", "--from", "0", "--to", "6"], "--vocals cannot be read as audio"],
    [["--vocals", "vocals.wav", "--words", "bad.json", "--out", "x", "--from", "0", "--to", "6"], "--words is not a words.json"],
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
  const result = film("window", dir, ["--vocals", "vocals.wav", "--words", "words.json", "--from", "0", "--to", "6", "--out", "y"], { PATH: "/nonexistent" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:window: ffprobe could not be started"]);
  assert.equal(existsSync(join(dir, "y")), false);
});
