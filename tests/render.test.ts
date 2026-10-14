import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOSING_FRAMES,
  CROSSFADE_FRAMES,
  FPS,
  OPENING_FRAMES,
  PROOF_FRAMES,
  scriptSeconds,
} from "../src/remotion/Teaser.tsx";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

type Clip = { file: string; in: number; out: number; caption: string };

function cutScript(clips: Clip[], overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-10-13",
    title: "What shipped on 13 October",
    opening: { headline: "The run shows its receipt", sub: "13 October" },
    clips,
    proof: { line: "Merged this week", source: "notablackbox/nabb-fe#1234" },
    closing: { line: "Not a black box." },
    posterFrame: 90,
    ...overrides,
  };
}

const captions = ["Every step, as it ran", "The board opens on today", "Jobs, with the shortlist beside them"];

function clipsCut(seconds: number, names = ["shot-01.webm", "shot-02.webm", "shot-03.webm"]): Clip[] {
  return names.map((file, i) => ({ file, in: 0, out: seconds, caption: captions[i % captions.length] }));
}

// A workspace per test: the caller's directory (INIT_CWD), a clips folder and a private
// system temp folder, so the test can see what render leaves behind there.
function workspace(placeholders: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-render-test-"));
  const clips = join(dir, "clips");
  const temp = join(dir, "tmp");
  mkdirSync(clips);
  mkdirSync(temp);
  for (const name of placeholders) writeFileSync(join(clips, name), "not a video");
  return { dir, clips, temp, out: join(dir, "out") };
}

function render(ws: ReturnType<typeof workspace>, script: unknown, extra: string[] = []) {
  const file = join(ws.dir, "cutscript.json");
  writeFileSync(file, typeof script === "string" ? script : JSON.stringify(script));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/render.ts", "--script", "cutscript.json", "--clips", "clips", "--out", "out", ...extra],
    {
      cwd: kitRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, INIT_CWD: ws.dir, TMPDIR: ws.temp, TMP: ws.temp, TEMP: ws.temp },
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

// The kit's own folders in the system temp folder (tsx and Remotion keep caches of their own there).
function kitTemp(ws: ReturnType<typeof workspace>): string[] {
  return readdirSync(ws.temp).filter((name) => name.startsWith("studio-kit-"));
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function assertRefused(ws: ReturnType<typeof workspace>, run: ReturnType<typeof render>, pattern: RegExp) {
  assert.equal(run.result.status, 2, run.output);
  assert.match(run.result.stdout, pattern);
  // A refusal writes nothing: no --out folder, so no report and no .mp4.
  assert.equal(existsSync(ws.out), false, "a refusal must not create --out");
  assert.deepEqual(kitTemp(ws), [], "a refusal makes no temp folder");
}

function probe(file: string) {
  const out = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  const stream = parsed.streams[0];
  return {
    codec: stream.codec_name as string,
    width: stream.width as number,
    height: stream.height as number,
    rate: stream.r_frame_rate as string,
    duration: Number(parsed.format?.duration),
  };
}

test("the length is the clips plus the cards less one cross-fade per join, from Teaser's constants", () => {
  assert.equal(FPS, 30);
  assert.equal(OPENING_FRAMES, 90);
  assert.equal(PROOF_FRAMES, 90);
  assert.equal(CLOSING_FRAMES, 120);
  assert.equal(CROSSFADE_FRAMES, 12);
  assert.equal(scriptSeconds(clipsCut(15)).toFixed(1), "53.0");
  assert.equal(scriptSeconds(clipsCut(5)).toFixed(1), "23.0");
  const five = clipsCut(8, ["a.webm", "b.webm", "c.webm", "d.webm", "e.webm"]);
  // 40 + 10 - 7 * 0.4 = 47.2
  assert.equal(scriptSeconds(five).toFixed(1), "47.2");
});

test("a script cut to 5 second clips is refused with its sum, before any work", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const run = render(ws, cutScript(clipsCut(5)));
  assertRefused(ws, run, /script runs 23\.0 seconds, want 45 to 60/);
  assert.deepEqual(lines(run.result.stdout), ["script runs 23.0 seconds, want 45 to 60"]);
});

test("a script over 60 seconds is refused", () => {
  const names = ["a.webm", "b.webm", "c.webm", "d.webm", "e.webm"];
  const ws = workspace(names);
  const run = render(ws, cutScript(clipsCut(12, names)));
  // 60 + 10 - 2.8 = 67.2
  assertRefused(ws, run, /^script runs 67\.2 seconds, want 45 to 60$/m);
});

test("a clip named ../x.webm is refused with exit 2", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  writeFileSync(join(ws.dir, "x.webm"), "outside the clips folder");
  const clips = clipsCut(15);
  clips[1].file = "../x.webm";
  const run = render(ws, cutScript(clips));
  assertRefused(ws, run, /\.\.\/x\.webm/);
});

test("a file with a slash, a backslash, a dot name or an absolute path is refused", () => {
  for (const bad of ["sub/shot-02.webm", "sub\\shot-02.webm", ".", "..", "/etc/hostname", ""]) {
    const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
    mkdirSync(join(ws.clips, "sub"));
    writeFileSync(join(ws.clips, "sub", "shot-02.webm"), "nested");
    const clips = clipsCut(15);
    clips[1].file = bad;
    const run = render(ws, cutScript(clips));
    assertRefused(ws, run, /clip 2/);
  }
});

test("a file that is not in --clips is refused", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm"]);
  const run = render(ws, cutScript(clipsCut(15)));
  assertRefused(ws, run, /shot-03\.webm/);
});

test("fewer than 3 clips or more than 5 are refused", () => {
  const two = workspace(["shot-01.webm", "shot-02.webm"]);
  assertRefused(two, render(two, cutScript(clipsCut(20, ["shot-01.webm", "shot-02.webm"]))), /3 to 5/);
  const names = ["a.webm", "b.webm", "c.webm", "d.webm", "e.webm", "f.webm"];
  const six = workspace(names);
  assertRefused(six, render(six, cutScript(clipsCut(6, names))), /3 to 5/);
});

test("an out not after its in, or a negative in, is refused", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const clips = clipsCut(15);
  clips[0] = { ...clips[0], in: 6, out: 6 };
  assertRefused(ws, render(ws, cutScript(clips)), /clip 1/);
  const negative = clipsCut(15);
  negative[2] = { ...negative[2], in: -1, out: 14 };
  assertRefused(ws, render(ws, cutScript(negative)), /clip 3/);
});

test("missing card text, a bad date and a poster frame outside the film are refused", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const clips = clipsCut(15);
  assertRefused(ws, render(ws, cutScript(clips, { opening: { headline: "", sub: "13 October" } })), /opening/);
  assertRefused(ws, render(ws, cutScript(clips, { proof: { line: "Merged" } })), /proof/);
  assertRefused(ws, render(ws, cutScript(clips, { closing: {} })), /closing/);
  assertRefused(ws, render(ws, cutScript(clips, { date: "13/10/2026" })), /date/);
  assertRefused(ws, render(ws, cutScript(clips, { posterFrame: 1590 })), /posterFrame/);
  assertRefused(ws, render(ws, cutScript(clips, { posterFrame: 12.5 })), /posterFrame/);
  const noCaption = clipsCut(15);
  noCaption[1].caption = "";
  assertRefused(ws, render(ws, cutScript(noCaption)), /clip 2/);
});

test("missing flags, an unreadable script and a script that is not JSON are refused", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const bare = spawnSync(process.execPath, ["--import", "tsx", "src/render.ts"], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: ws.dir },
  });
  assert.equal(bare.status, 2);
  const noOut = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/render.ts", "--script", "cutscript.json", "--clips", "clips"],
    { cwd: kitRoot, encoding: "utf8", env: { ...process.env, INIT_CWD: ws.dir } },
  );
  assert.equal(noOut.status, 2);
  assertRefused(ws, render(ws, "{not json"), /cut script/);
});

test("a clip ffmpeg cannot read fails the transcode step: report written, ok false, exit 1", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const run = render(ws, cutScript(clipsCut(15)));
  assert.equal(run.result.status, 1, run.output);
  assert.deepEqual(readdirSync(ws.out), ["render-report.json"]);
  const report = JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.date, "2026-10-13");
  assert.deepEqual(report.clips, ["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const last = report.steps[report.steps.length - 1];
  assert.equal(last.name, "transcode");
  assert.equal(last.ok, false);
  assert.match(last.error, /shot-01\.webm/);
  assert.deepEqual(kitTemp(ws), [], "the temp folder is removed on failure too");
});

test(
  "three whole 15 second clips render a master, a 4:5 reframe and a poster, measured in the report",
  { timeout: 20 * 60 * 1000 },
  (t) => {
    const ws = workspace();
    const shotlist = join(ws.dir, "shotlist.json");
    writeFileSync(
      shotlist,
      JSON.stringify({
        date: "2026-10-13",
        shots: [
          { n: 1, surface: "Office", route: "/app/office", dwell: 15, clicks: [], caption: captions[0] },
          { n: 2, surface: "Home", route: "/app/home", dwell: 15, clicks: [], caption: captions[1] },
          { n: 3, surface: "Hiring", route: "/app/jobs", dwell: 15, clicks: [], caption: captions[2] },
        ],
      }),
    );
    const walk = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/walk.ts", "--shotlist", shotlist, "--out", ws.clips, "--synthetic"],
      { cwd: kitRoot, encoding: "utf8", env: { ...process.env, INIT_CWD: ws.dir } },
    );
    assert.equal(walk.status, 0, walk.stderr);

    const clips = clipsCut(15);
    const sum = scriptSeconds(clips);
    assert.equal(sum.toFixed(1), "53.0");

    const started = Date.now();
    const run = render(ws, cutScript(clips));
    const wall = ((Date.now() - started) / 1000).toFixed(1);
    assert.equal(run.result.status, 0, run.output);
    t.diagnostic(`render wall time: ${wall} s`);

    assert.deepEqual(readdirSync(ws.out).sort(), ["poster.png", "render-report.json", "teaser-4x5.mp4", "teaser.mp4"]);
    assert.deepEqual(kitTemp(ws), [], "render removes its temp folder");

    const master = probe(join(ws.out, "teaser.mp4"));
    assert.equal(master.codec, "h264");
    assert.equal(master.width, 1920);
    assert.equal(master.height, 1080);
    assert.equal(master.rate, "30/1");
    assert.ok(Math.abs(master.duration - sum) <= 0.5, `master runs ${master.duration}, sum ${sum}`);
    assert.ok(master.duration >= 45 && master.duration <= 60);

    const social = probe(join(ws.out, "teaser-4x5.mp4"));
    assert.equal(social.codec, "h264");
    assert.equal(social.width, 1080);
    assert.equal(social.height, 1350);
    assert.equal(social.rate, "30/1");
    assert.ok(Math.abs(social.duration - sum) <= 0.5, `reframe runs ${social.duration}, sum ${sum}`);

    const poster = readFileSync(join(ws.out, "poster.png"));
    assert.deepEqual([...poster.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(poster.readUInt32BE(16), 1920);
    assert.equal(poster.readUInt32BE(20), 1080);

    const report = JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.date, "2026-10-13");
    assert.deepEqual(report.clips, ["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
    assert.deepEqual(
      report.steps,
      ["transcode", "render-teaser", "render-teaser-4x5", "still-poster", "measure"].map((name) => ({
        name,
        ok: true,
        error: "",
      })),
    );
    assert.equal(report.outputs.teaser.file, "teaser.mp4");
    assert.ok(Math.abs(report.outputs.teaser.durationSeconds - master.duration) < 0.05);
    assert.equal(report.outputs.teaser.width, 1920);
    assert.equal(report.outputs.teaser.height, 1080);
    assert.equal(report.outputs.teaser.fps, 30);
    assert.deepEqual(
      { ...report.outputs.teaser4x5, durationSeconds: 0 },
      { file: "teaser-4x5.mp4", durationSeconds: 0, width: 1080, height: 1350, fps: 30 },
    );
    assert.deepEqual(report.outputs.poster, { file: "poster.png", width: 1920, height: 1080 });
  },
);
