import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOSING_FRAMES, CROSSFADE_FRAMES, FPS, OPENING_FRAMES, PROOF_FRAMES, fitText, type Look } from "../src/remotion/Teaser.tsx";
import { captionBelowHeight } from "../src/remotion/cards/LowerThird.tsx";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));
const CLIP_SECONDS = 3;

// One fixed props file for all four stills. The composition takes the cut script with each
// clip's file naming an .mp4 in the public folder, as render.ts hands it over.
const props = {
  date: "2026-10-13",
  title: "What shipped on 13 October",
  opening: { headline: "The run shows its receipt", sub: "13 October" },
  clips: [
    { file: "shot-01.mp4", in: 0, out: CLIP_SECONDS, caption: "Every step, as it ran" },
    { file: "shot-02.mp4", in: 0.5, out: CLIP_SECONDS, caption: "The board opens on today" },
    { file: "shot-03.mp4", in: 0, out: CLIP_SECONDS, caption: "Jobs, with the shortlist beside them" },
  ],
  proof: { line: "Merged this week", source: "notablackbox/nabb-fe#1234" },
  closing: { line: "Not a black box." },
  posterFrame: 30,
};

const clipFrames = props.clips.map((c) => Math.round((c.out - c.in) * FPS));
const clipsTotal = clipFrames.reduce((a, b) => a + b, 0);
const total = OPENING_FRAMES + clipsTotal + PROOF_FRAMES + CLOSING_FRAMES - (props.clips.length + 2) * CROSSFADE_FRAMES;
const firstClipStart = OPENING_FRAMES - CROSSFADE_FRAMES;
// Clip 2 starts at 0.5 s into its file, so its still exercises the trim.
const secondClipStart = firstClipStart + clipFrames[0] - CROSSFADE_FRAMES;
const proofStart = OPENING_FRAMES + clipsTotal - (props.clips.length + 1) * CROSSFADE_FRAMES;
const closingStart = total - CLOSING_FRAMES;

// One frame inside each card's span, clear of the cross-fades.
const frames: Record<string, number> = {
  opening: Math.round(OPENING_FRAMES / 2),
  clip: secondClipStart + Math.round(clipFrames[1] / 2),
  proof: proofStart + Math.round(PROOF_FRAMES / 2),
  closing: closingStart + Math.round(CLOSING_FRAMES / 2),
};

let dir = "";
let publicDir = "";
let propsFile = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-kit-cards-"));
  publicDir = join(dir, "public");
  mkdirSync(publicDir);
  for (const clip of props.clips) {
    const made = spawnSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=1920x1080:rate=${FPS}`,
        "-t", String(CLIP_SECONDS),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        join(publicDir, clip.file),
      ],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
  }
  propsFile = join(dir, "props.json");
  writeFileSync(propsFile, JSON.stringify(props));
});

// The stills and the clips are removed once the file's tests are done.
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The caption fit, without a render: the 4:5 frame's look, as Teaser builds it.
const social = { width: 1080, height: 1350, t: 1, margin: 90, fitText } as unknown as Look;
const master = { width: 1920, height: 1080, t: 1, margin: 160, fitText } as unknown as Look;

test("a caption steps down from 48 px to fit two lines, never below 32 px", () => {
  const words = "Every step of the run, as it ran, with the receipt beside it";
  assert.deepEqual(fitText(words, 48, 32, 900, 2), { size: 48, lines: 2 });
  const wide = fitText("W".repeat(45), 48, 32, 900, 2);
  assert.ok(wide.size < 48 && wide.size >= 32 && wide.lines <= 2, JSON.stringify(wide));
  for (const caption of ["W".repeat(60), "漢".repeat(60)]) {
    const fit = fitText(caption, 48, 32, 900, 2);
    assert.equal(fit.size, 32, caption.slice(0, 3));
    assert.ok(fit.lines >= 2);
    assert.deepEqual(fitText(caption, 48, 32, 1600, 2), { size: 48, lines: 2 }, "16:9 fits two lines at 48 px");
  }
});

test("the 4:5 caption room is two 48 px lines for every caption that fits them, and the real height beyond", () => {
  const two = (48 + 2 * 48 * 1.2);
  for (const caption of ["A caption", "Every step of the run, as it ran, with the receipt beside it", "W".repeat(45)]) {
    assert.equal(captionBelowHeight(caption, social), two, caption);
  }
  const cjk = "漢".repeat(60);
  const fit = fitText(cjk, 48, 32, 900, 2);
  assert.equal(captionBelowHeight(cjk, social), Math.max(two, 48 + fit.lines * fit.size * 1.2));
  assert.equal(captionBelowHeight(cjk, master), two);
});

for (const [card, frame] of Object.entries(frames)) {
  test(`the ${card} card renders to a still (frame ${frame})`, { timeout: 5 * 60 * 1000 }, () => {
    assert.ok(frame >= 0 && frame < total);
    const png = join(dir, `${card}.png`);
    const still = spawnSync(
      "npx",
      [
        "remotion", "still", "src/remotion/Root.tsx", "Teaser", png,
        `--props=${propsFile}`,
        `--public-dir=${publicDir}`,
        `--frame=${frame}`,
        "--log=error",
      ],
      { cwd: kitRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(still.status, 0, `${still.stdout}${still.stderr}`);
    assert.ok(existsSync(png));
    const bytes = readFileSync(png);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(bytes.readUInt32BE(16), 1920);
    assert.equal(bytes.readUInt32BE(20), 1080);
  });
}
