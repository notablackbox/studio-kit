import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, tempDir } from "./fixtures/film.ts";

// film:flash: WCAG 2.3.1's general flash threshold at 96x54 and 24 fps, counted as pairs of
// opposing transitions; single-frame pops fail too. Videos made with ffmpeg's test sources.

let dir = "";
before(() => {
  dir = tempDir("flash");
});

// A grey video whose luma per frame N is `expr` (0 to 255).
function video(name: string, expr: string, seconds = 2): string {
  const result = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=192x108:r=24:d=${seconds}`,
    "-vf", `format=gray,geq=lum='${expr}',format=yuv420p`, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", join(dir, name),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return name;
}

const report = (out: string) => JSON.parse(readFileSync(join(dir, out, "flash-report.json"), "utf8"));

test("a steady picture with a slow fade is clean", () => {
  const result = film("flash", dir, ["--video", video("steady.mp4", "60+N*2"), "--out", "steady"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ["flash: clean, 48 frames, at most 0 flashes and 0 red flashes in any second, no pops"]);
  const r = report("steady");
  assert.equal(r.ok, true);
  assert.deepEqual(r.windows, []);
  assert.deepEqual(r.pops, []);
});

test("three flashes a second pass: pairs are counted, not transitions", () => {
  const result = film("flash", dir, ["--video", video("three.mp4", "if(lt(mod(N,8),4),220,20)"), "--out", "three"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(report("three").worst_second.count, 3);
});

test("four flashes in a second fail with exit 3, the window in the report", () => {
  const result = film("flash", dir, ["--video", video("four.mp4", "if(lt(mod(N,6),3),220,20)"), "--out", "four"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const out = lines(result.stdout);
  assert.equal(out.length, 1);
  assert.match(out[0], /^flash: 4 flashes in one second between \d\.\d{3} and \d\.\d{3} s, want at most 3$/);
  const r = report("four");
  assert.equal(r.ok, false);
  assert.equal(r.worst_second.count, 4);
  assert.ok(r.windows.length >= 1);
});

test("a single-frame pop is flagged as a warning, never failed (R-a)", () => {
  const result = film("flash", dir, ["--video", video("pop.mp4", "if(eq(N,12),118,100)"), "--out", "pop"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = lines(result.stdout);
  assert.equal(out.length, 2);
  assert.equal(out[0], "flash: clean, 48 frames, at most 0 flashes and 0 red flashes in any second, 1 pop flagged");
  assert.match(out[1], /^warning: a single-frame pop at 0\.500 s \(frame 12\): mean luminance 0\.1\d+ -> 0\.1\d+ -> 0\.1\d+$/);
  assert.equal(report("pop").ok, true);
  assert.equal(report("pop").pops.length, 1);
  assert.deepEqual(report("pop").flashes, []);
});

// Full-screen saturated red (255, 0, 0) and the gray of equal relative luminance (127: linear
// 0.2126), alternating every `half` frames; lossless RGB, so the red stays saturated.
function redGray(name: string, half: number, seconds = 2): string {
  const on = `lt(mod(N,${2 * half}),${half})`;
  const result = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=192x108:r=24:d=${seconds}`,
    "-vf", `format=rgb24,geq=r='if(${on},255,127)':g='if(${on},0,127)':b='if(${on},0,127)'`,
    "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", join(dir, name),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return name;
}

test("saturated red flashes at equal luminance: six a second fail, two pass", () => {
  const fast = film("flash", dir, ["--video", redGray("red6.mp4", 2), "--out", "red6"]);
  assert.equal(fast.status, 3, fast.stdout + fast.stderr);
  const out = lines(fast.stdout);
  assert.equal(out.length, 1);
  assert.match(out[0], /^flash: 6 red flashes in one second between \d\.\d{3} and \d\.\d{3} s, want at most 3$/);
  const r = report("red6");
  assert.equal(r.ok, false);
  // The luminance alone sees nothing: the general count stays clean.
  assert.equal(r.worst_second.count, 0);
  assert.deepEqual(r.windows, []);
  assert.equal(r.worst_red_second.count, 6);
  assert.ok(r.red_windows.length >= 1);
  assert.equal(r.rule.red, 0.8);

  const slow = film("flash", dir, ["--video", redGray("red2.mp4", 6), "--out", "red2"]);
  assert.equal(slow.status, 0, slow.stdout + slow.stderr);
  assert.deepEqual(lines(slow.stdout), ["flash: clean, 48 frames, at most 0 flashes and 2 red flashes in any second, no pops"]);
  assert.equal(report("red2").worst_red_second.count, 2);
});

// A gray 124 frame (linear 0.2016) whose top-left quarter (with a few pixels to spare for the
// scaling to 96x54: 100x56 of 192x108) alternates every 2 frames (6 Hz) with gray `lit`; the
// rest never changes, so the frame's mean moves by about a quarter of the region's change.
function region(name: string, lit: number, seconds = 2): string {
  const v = `if(lt(X,100)*lt(Y,56)*lt(mod(N,4),2),${lit},124)`;
  const result = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=192x108:r=24:d=${seconds}`,
    "-vf", `format=rgb24,geq=r='${v}':g='${v}':b='${v}'`,
    "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", join(dir, name),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return name;
}

test("a quarter of the frame flashing fails though the whole frame's mean barely moves", () => {
  // 160 is linear 0.3515: the region changes by 0.15, the mean by under 0.05.
  const fast = film("flash", dir, ["--video", region("area15.mp4", 160), "--out", "area15"]);
  assert.equal(fast.status, 3, fast.stdout + fast.stderr);
  const out = lines(fast.stdout);
  assert.equal(out.length, 1);
  assert.match(out[0], /^flash: 6 flashes in one second between \d\.\d{3} and \d\.\d{3} s, want at most 3$/);
  const r = report("area15");
  assert.equal(r.worst_second.count, 6);
  assert.ok(r.transitions.every((t: { area: number }) => t.area >= 0.25));
  assert.ok(Math.max(...r.mean_luminance) - Math.min(...r.mean_luminance) < 0.1);
  // 137 is linear 0.2502: a change of 0.05, under WCAG's 0.1, is no flash however fast.
  const faint = film("flash", dir, ["--video", region("area05.mp4", 137), "--out", "area05"]);
  assert.equal(faint.status, 0, faint.stdout + faint.stderr);
  assert.deepEqual(lines(faint.stdout), ["flash: clean, 48 frames, at most 0 flashes and 0 red flashes in any second, no pops"]);
});

test("refusals: missing flags, a file that is not a video", () => {
  const cases: [string[], string[]][] = [
    [["--video", "steady.mp4"], ["film:flash: --video and --out are required"]],
    [["--video", "nothing.mp4", "--out", "x"], ["--video cannot be read"]],
  ];
  for (const [args, want] of cases) {
    const result = film("flash", dir, args);
    assert.equal(result.status, 2);
    assert.deepEqual(lines(result.stdout), want);
  }
  assert.equal(existsSync(join(dir, "x")), false);
});
