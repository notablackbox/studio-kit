import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, tempDir } from "./fixtures/film.ts";
import { fakeVideo } from "./fixtures/chapter.ts";

// film:encode: the chapters concatenated with the mix, a CRF 16 master tagged BT.709 and a CRF
// 20 review copy, both verified with ffprobe.

let dir = "";
before(() => {
  dir = tempDir("encode");
  fakeVideo(join(dir, "ch01.mp4"), 2, "testsrc2", "640x360");
  fakeVideo(join(dir, "ch02.mp4"), 1.5, "smptebars", "640x360");
  fakeVideo(join(dir, "wide.mp4"), 1, "testsrc2", "320x180");
  for (const [name, seconds] of [["mix.wav", 3.5], ["short.wav", 2], ["long.wav", 5]] as const) {
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}:sample_rate=48000`, "-c:a", "pcm_s24le", join(dir, name)]);
    assert.equal(made.status, 0);
  }
  // Each chapter's tokens sidecar beside it records how it was rendered (ramp true); one
  // rendered with the test-only --no-ramp says ramp false; one has no sidecar at all.
  for (const name of ["ch01", "ch02", "wide"]) writeFileSync(join(dir, `${name}.tokens.json`), JSON.stringify({ fps: 24, chapter: name, ramp: true, frames: [] }));
  mkdirSync(join(dir, "unramped"));
  fakeVideo(join(dir, "unramped", "fl.mp4"), 2, "testsrc2", "640x360");
  writeFileSync(join(dir, "unramped", "fl.tokens.json"), JSON.stringify({ fps: 24, chapter: "fl", ramp: false, frames: [] }));
  mkdirSync(join(dir, "bare"));
  fakeVideo(join(dir, "bare", "ch09.mp4"), 2, "testsrc2", "640x360");
});

function probe(file: string) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,r_frame_rate,color_primaries,color_transfer,color_space:format=duration", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(result.stdout);
}

test("an encode whose ffprobe shows BT.709, 24 fps and the chapters' sum", () => {
  const result = film("encode", dir, ["--chapters", "ch01.mp4", "ch02.mp4", "--mix", "mix.wav", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lines(result.stdout)[0], /^encode: master\.mp4 3\.\d{3} s \(the chapters 3\.500 s\), 640x360 24 fps, bt709, \d+ bytes; review\.mp4 \d+ bytes$/);
  assert.deepEqual(readdirSync(join(dir, "out")).sort(), ["encode-report.json", "master.mp4", "review.mp4"]);
  for (const name of ["master.mp4", "review.mp4"]) {
    const p = probe(join(dir, "out", name));
    const video = p.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const audio = p.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.r_frame_rate, "24/1");
    assert.deepEqual([video.color_primaries, video.color_transfer, video.color_space], ["bt709", "bt709", "bt709"]);
    assert.equal(audio.codec_name, "aac");
    assert.ok(Math.abs(Number(p.format.duration) - 3.5) <= 0.5, p.format.duration);
  }
  const report = JSON.parse(readFileSync(join(dir, "out", "encode-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.chapters_seconds, 3.5);
  assert.equal(report.master.color_space, "bt709");
});

test("refusals: chapters of different sizes, a mix that is not audio, missing flags", () => {
  const cases: [string[], string[]][] = [
    [["--chapters", "ch01.mp4"], ["film:encode: --chapters <mp4>..., --mix and --out are required"]],
    [["--chapters", "ch01.mp4", "wide.mp4", "--mix", "mix.wav", "--out", "x"], ['--chapters: "wide.mp4" measures 320x180, the first 640x360']],
    [["--chapters", "ch01.mp4", "--mix", "ch02.mp4", "--out", "x"], ["--mix cannot be read as audio"]],
    [["--chapters", "ch01.mp4", "ch02.mp4", "--mix", "short.wav", "--out", "x"], ["--mix runs 2.000 s, shorter than the chapters (3.500 s)"]],
    [["--chapters", "ch01.mp4", "ch02.mp4", "--mix", "long.wav", "--out", "x"], ["--mix runs 5.000 s, longer than the chapters (3.500 s) by more than 0.5 s"]],
    [["--chapters", "unramped/fl.mp4", "--mix", "short.wav", "--out", "x"], ['--chapters: "fl.mp4" was rendered with --no-ramp (its sidecar fl.tokens.json says ramp: false); give --allow-unramped to encode it anyway']],
    [["--chapters", "bare/ch09.mp4", "--mix", "short.wav", "--out", "x"], ['--chapters: "ch09.mp4" has no tokens sidecar beside it (ch09.tokens.json) to show how it was rendered; give --allow-unramped to encode it anyway']],
  ];
  for (const [args, want] of cases) {
    const result = film("encode", dir, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), want);
  }
  assert.equal(existsSync(join(dir, "x")), false);
});


test("an unramped chapter encodes only with --allow-unramped, recorded in the report", () => {
  const result = film("encode", dir, ["--chapters", "unramped/fl.mp4", "--mix", "short.wav", "--allow-unramped", "--out", "allowed"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "allowed", "encode-report.json"), "utf8")).inputs.allow_unramped, true);
});
