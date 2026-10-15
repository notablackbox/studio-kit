import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOSING_FRAMES,
  CROSSFADE_FRAMES,
  FPS,
  OPENING_FRAMES,
  PROOF_FRAMES,
  scriptSeconds,
  teaserFrames,
  type TeaserProps,
} from "../src/remotion/Teaser.tsx";
import { checkOut, runProcess, validateScript, work, type Runner } from "../src/render.ts";
import { holdHeavy } from "./fixtures/heavy.ts";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

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
  const dir = tempDir("studio-kit-render-test-");
  const clips = join(dir, "clips");
  const temp = join(dir, "tmp");
  mkdirSync(clips);
  mkdirSync(temp);
  for (const name of placeholders) writeFileSync(join(clips, name), "not a video");
  return { dir, clips, temp, out: join(dir, "out") };
}

function render(ws: ReturnType<typeof workspace>, script: unknown, folders: { clips?: string; out?: string } = {}) {
  const file = join(ws.dir, "cutscript.json");
  writeFileSync(file, typeof script === "string" ? script : JSON.stringify(script));
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "src/render.ts",
      "--script", "cutscript.json",
      "--clips", folders.clips ?? "clips",
      "--out", folders.out ?? "out",
    ],
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
      "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration",
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
    frames: Number(stream.nb_frames),
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

// Clips whose in and out do not fall on frames: the gate must count frames the way the
// composition does, so a script it lets through can never measure outside 45 to 60.
function misaligned(outs: number[]): Clip[] {
  return outs.map((out, i) => ({ file: `shot-0${i + 1}.webm`, in: 0, out, caption: captions[i % captions.length] }));
}

test("the gate counts frames as the composition does: 12.31, 12.31, 12.38 is 1349 frames and refused", () => {
  const clips = misaligned([12.31, 12.31, 12.38]);
  assert.equal(teaserFrames(clips), 1349);
  const ws = workspace(clips.map((c) => c.file));
  const run = render(ws, cutScript(clips));
  // 44.97 seconds floors to 44.9: the line never says a number inside the range it refuses.
  assertRefused(ws, run, /^script runs 44\.9 seconds, want 45 to 60$/m);
});

test("the gate counts frames as the composition does: 3 x 12.32 is 1350 frames, 45.0 seconds, and accepted", () => {
  const clips = misaligned([12.32, 12.32, 12.32]);
  assert.equal(teaserFrames(clips), 1350);
  const ws = workspace(clips.map((c) => c.file));
  const run = render(ws, cutScript(clips));
  // Accepted: work starts, and the placeholder clips fail the transcode step, not the gate.
  assert.equal(run.result.status, 1, run.output);
  assert.doesNotMatch(run.result.stdout, /script runs/);
  const report = JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8"));
  assert.equal(report.steps[0].name, "transcode");
});

test("a script just over 60 seconds by the frame count prints a value over 60", () => {
  const clips = misaligned([10.567, 10.567, 10.567, 10.567, 10.567]);
  assert.equal(teaserFrames(clips), 1801);
  const ws = workspace(clips.map((c) => c.file));
  assertRefused(ws, render(ws, cutScript(clips)), /^script runs 60\.1 seconds, want 45 to 60$/m);
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
  assert.deepEqual(lines(bare.stdout), ["render: --script <path>, --clips <dir> and --out <dir> are required"]);
  const noOut = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/render.ts", "--script", "cutscript.json", "--clips", "clips"],
    { cwd: kitRoot, encoding: "utf8", env: { ...process.env, INIT_CWD: ws.dir } },
  );
  assert.equal(noOut.status, 2);
  assert.deepEqual(lines(noOut.stdout), ["render: --script <path>, --clips <dir> and --out <dir> are required"]);
  const outFile = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  writeFileSync(outFile.out, "a file, not a folder");
  const notFolder = render(outFile, cutScript(clipsCut(15)));
  assert.equal(notFolder.result.status, 2, notFolder.output);
  assert.deepEqual(lines(notFolder.result.stdout), ["--out is not a folder"]);
  const noClips = workspace();
  rmSync(noClips.clips, { recursive: true });
  const missingClips = render(noClips, cutScript(clipsCut(15)));
  assert.equal(missingClips.result.status, 2);
  assert.match(missingClips.result.stdout, /^--clips is not a folder$/m);
  assertRefused(ws, render(ws, "{not json"), /cut script/);
});

// Accepted by the gate: work starts and the placeholder clips fail the transcode step.
function assertAccepted(ws: ReturnType<typeof workspace>, run: ReturnType<typeof render>) {
  assert.equal(run.result.status, 1, run.output);
  assert.deepEqual(lines(run.result.stdout), [], run.result.stdout);
  const report = JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8"));
  assert.equal(report.steps[0].name, "transcode");
  rmSync(ws.out, { recursive: true, force: true });
}

const astral = (count: number) => "\u{1F600}".repeat(count);

test("caption length counts code points: 60 astral characters pass, 61 are refused", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const sixty = clipsCut(15);
  sixty[0].caption = astral(60);
  assert.equal(sixty[0].caption.length, 120);
  assertAccepted(ws, render(ws, cutScript(sixty)));
  const over = clipsCut(15);
  over[0].caption = astral(61);
  const run = render(ws, cutScript(over));
  assertRefused(ws, run, /clip 1: caption must be 1 to 60 characters/);
  assert.equal(lines(run.result.stdout).length, 1);
});

const cardFields = [
  { field: "opening.headline", limit: 60, set: (text: string) => ({ opening: { headline: text, sub: "13 October" } }) },
  { field: "opening.sub", limit: 80, set: (text: string) => ({ opening: { headline: "The run", sub: text } }) },
  { field: "proof.line", limit: 80, set: (text: string) => ({ proof: { line: text, source: "notablackbox/nabb-fe#1" } }) },
  { field: "proof.source", limit: 80, set: (text: string) => ({ proof: { line: "Merged", source: text } }) },
  { field: "closing.line", limit: 80, set: (text: string) => ({ closing: { line: text } }) },
];

for (const { field, limit, set } of cardFields) {
  test(`${field} over ${limit} characters is refused with one line naming it; ${limit}, astral included, passes`, () => {
    const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
    const clips = clipsCut(15);
    const run = render(ws, cutScript(clips, set("x".repeat(limit + 1))));
    assertRefused(ws, run, new RegExp(`^${field.replace(".", "\\.")} runs ${limit + 1} characters, want at most ${limit}$`, "m"));
    assert.equal(lines(run.result.stdout).length, 1, run.result.stdout);
    assertRefused(ws, render(ws, cutScript(clips, set(astral(limit + 1)))), new RegExp(field.replace(".", "\\.")));
    assertAccepted(ws, render(ws, cutScript(clips, set("x".repeat(limit)))));
    assertAccepted(ws, render(ws, cutScript(clips, set(astral(limit)))));
  });
}

test("--out that is --clips, or inside it, is refused before any work", () => {
  for (const [clips, out] of [["clips", "clips"], ["clips", "clips/out"]]) {
    const ws = workspace();
    mkdirSync(join(ws.dir, clips), { recursive: true });
    for (const name of ["shot-01.webm", "shot-02.webm", "shot-03.webm"]) writeFileSync(join(ws.dir, clips, name), "x");
    const before = readdirSync(join(ws.dir, clips)).sort();
    const run = render(ws, cutScript(clipsCut(15)), { clips, out });
    assert.equal(run.result.status, 2, `${clips} ${out}: ${run.output}`);
    assert.deepEqual(lines(run.result.stdout), ["--out must not be the --clips folder or inside it"]);
    assert.deepEqual(readdirSync(join(ws.dir, clips)).sort(), before, "nothing written into --clips");
    if (out !== clips) assert.equal(existsSync(join(ws.dir, out)), false);
    assert.deepEqual(kitTemp(ws), []);
  }
});

test("--out or --clips under a file, or a dangling symlink, is refused as not a folder before any work", () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  writeFileSync(join(ws.dir, "afile"), "a file, not a folder");
  symlinkSync(join(ws.dir, "nowhere"), join(ws.dir, "dangling"));
  for (const out of ["afile/sub", "afile/sub/deeper", "dangling", "dangling/sub"]) {
    const run = render(ws, cutScript(clipsCut(15)), { out });
    assert.equal(run.result.status, 2, `${out}: ${run.output}`);
    assert.deepEqual(lines(run.result.stdout), ["--out is not a folder"], out);
    assert.equal(existsSync(join(ws.dir, "nowhere")), false, "nothing made through the link");
    assert.deepEqual(kitTemp(ws), []);
  }
  for (const clips of ["afile/sub", "dangling"]) {
    const run = render(ws, cutScript(clipsCut(15)), { clips });
    assert.equal(run.result.status, 2, `${clips}: ${run.output}`);
    assert.match(run.result.stdout, /^--clips is not a folder$/m, clips);
    assert.equal(existsSync(ws.out), false);
  }
});

test("a --clips folder below --out passes the gate: the skill's /work and /work/raw/<date> shape", () => {
  const work = tempDir("studio-kit-work-");
  const clips = join(work, "raw", "2026-10-13");
  mkdirSync(clips, { recursive: true });
  for (const name of ["shot-01.webm", "shot-02.webm", "shot-03.webm"]) writeFileSync(join(clips, name), "x");
  writeFileSync(join(work, "cutscript.json"), JSON.stringify(cutScript(clipsCut(15))));
  assert.deepEqual(checkOut(work, clips), []);
  const { script, problems } = validateScript(cutScript(clipsCut(15)), clips);
  assert.deepEqual(problems, []);
  assert.ok(script);
  // The same through a subfolder named like the README's example, relative to INIT_CWD.
  const ws = workspace();
  mkdirSync(join(ws.dir, "out", "clips"), { recursive: true });
  assert.deepEqual(checkOut(join(ws.dir, "out"), join(ws.dir, "out", "clips")), []);
});

test("a clip named like one of render's own outputs is refused", () => {
  for (const name of ["teaser.mp4", "teaser-4x5.mp4", "poster.png", "render-report.json"]) {
    const ws = workspace(["shot-01.webm", "shot-02.webm", name]);
    const clips = clipsCut(15);
    clips[2].file = name;
    const run = render(ws, cutScript(clips));
    assertRefused(ws, run, new RegExp(`^clip 3: "${name.replace(".", "\\.")}" is a name render writes in --out$`, "m"));
  }
});

test("a newline or control character in a clip name cannot forge a line: one problem is one line", () => {
  for (const bad of ["a\nscript runs 50.0 seconds", "a\r\nb.webm", "a\u001b[2Jb.webm", "a\u2028b.webm", "a\u0085b.webm"]) {
    const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
    try {
      writeFileSync(join(ws.clips, bad), "x");
    } catch {
      // A name the file system will not hold is still refused below.
    }
    const clips = clipsCut(15);
    clips[1].file = bad;
    const run = render(ws, cutScript(clips));
    assertRefused(ws, run, /clip 2/);
    assert.equal(run.result.stdout.split("\n").filter((l) => l !== "").length, 1, JSON.stringify(run.result.stdout));
    assert.doesNotMatch(run.result.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/, JSON.stringify(run.result.stdout));
  }
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

// The steps after the transcode, without a render: work() takes the process runner as a seam,
// and this one writes the files Remotion would and answers ffprobe with what it is told.
type Fake = {
  failOn?: (args: string[]) => "fail" | "timeout" | undefined;
  measures?: Record<string, { duration: number; width: number; height: number; frames?: number }>;
};

function fakeRunner(fake: Fake, seen: { temp: string }): Runner {
  return async (command, args) => {
    const ok = { status: 0, stdout: "", stderr: "", timedOut: false };
    const target = args[args.length - 1];
    if (command === "ffmpeg") {
      seen.temp = dirname(dirname(target));
      writeFileSync(target, "mp4");
      return ok;
    }
    if (command === "ffprobe") {
      const name = basename(target);
      const m = fake.measures?.[name] ?? { duration: 15, width: 1920, height: 1080 };
      const stream = { width: m.width, height: m.height, r_frame_rate: "30/1", nb_frames: String(m.frames ?? Math.round(m.duration * 30)) };
      return { ...ok, stdout: JSON.stringify({ streams: [stream], format: { duration: String(m.duration) } }) };
    }
    // npx remotion render|still <entry> <composition> <output> ...
    const output = args[4];
    const verdict = fake.failOn?.(args);
    if (verdict === "timeout") return { ...ok, status: null, timedOut: true };
    writeFileSync(output, "partial");
    if (verdict === "fail") return { ...ok, status: 1, stderr: "boom" };
    return ok;
  };
}

const goodMeasures = {
  "teaser.mp4": { duration: 53, width: 1920, height: 1080, frames: 1590 },
  "teaser-4x5.mp4": { duration: 53, width: 1080, height: 1350, frames: 1590 },
  "poster.png": { duration: NaN, width: 1920, height: 1080 },
};

async function runWork(fake: Fake) {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const seen = { temp: "" };
  const script = cutScript(clipsCut(15)) as unknown as TeaserProps;
  const report = await work(script, ws.clips, ws.out, { run: fakeRunner(fake, seen), log: () => {} });
  assert.ok(seen.temp, "the transcode wrote into a temp folder");
  assert.equal(existsSync(seen.temp), false, "the temp folder is removed");
  return { ws, report, files: readdirSync(ws.out).sort() };
}

test("seam check: with every step passing, work leaves the four outputs and a full report", async () => {
  const { report, files } = await runWork({ measures: goodMeasures });
  assert.equal(report.ok, true);
  assert.deepEqual(files, ["poster.png", "render-report.json", "teaser-4x5.mp4", "teaser.mp4"]);
  assert.equal(report.outputs.teaser?.durationSeconds, 53);
});

test("a failure after render-teaser leaves only render-report.json, with no outputs", async () => {
  const { report, files, ws } = await runWork({
    measures: goodMeasures,
    failOn: (args) => (args.includes("TeaserSocial") ? "fail" : undefined),
  });
  assert.deepEqual(files, ["render-report.json"]);
  const written = JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8"));
  assert.deepEqual(written, report);
  assert.equal(written.ok, false);
  assert.deepEqual(written.outputs, {});
  assert.deepEqual(
    written.steps.map((s: { name: string; ok: boolean }) => [s.name, s.ok]),
    [["transcode", true], ["render-teaser", true], ["render-teaser-4x5", false]],
  );
  assert.match(written.steps[2].error, /TeaserSocial/);
});

test("a step that runs past its time limit fails in the kit's words", async () => {
  const { report, files } = await runWork({
    measures: goodMeasures,
    failOn: (args) => (args.includes("Teaser") && args[1] === "render" ? "timeout" : undefined),
  });
  assert.deepEqual(files, ["render-report.json"]);
  assert.equal(report.steps[1].name, "render-teaser");
  assert.match(report.steps[1].error, /took longer than 15 minutes/);
});

test("a symlink in --out at the report's or an output's name is replaced, never written through", async () => {
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  const outside = join(ws.dir, "outside");
  mkdirSync(outside);
  mkdirSync(ws.out);
  for (const name of ["render-report.json", "teaser.mp4"]) {
    writeFileSync(join(outside, name), "keep me");
    symlinkSync(join(outside, name), join(ws.out, name));
  }
  const script = cutScript(clipsCut(15)) as unknown as TeaserProps;
  for (const fake of [{ measures: goodMeasures }, { measures: goodMeasures, failOn: () => "fail" as const }]) {
    const report = await work(script, ws.clips, ws.out, { run: fakeRunner(fake, { temp: "" }), log: () => {} });
    for (const name of ["render-report.json", "teaser.mp4"]) {
      assert.equal(readFileSync(join(outside, name), "utf8"), "keep me", `${name} was written through`);
    }
    assert.equal(lstatSync(join(ws.out, "render-report.json")).isFile(), true);
    assert.deepEqual(JSON.parse(readFileSync(join(ws.out, "render-report.json"), "utf8")), report);
    assert.deepEqual(readdirSync(ws.out).filter((n) => n.endsWith(".tmp")), [], "no temp report left");
    // Put the links back for the failing pass.
    for (const name of ["render-report.json", "teaser.mp4"]) {
      rmSync(join(ws.out, name), { force: true });
      symlinkSync(join(outside, name), join(ws.out, name));
    }
  }
});

test("measure fails a reframe whose length is off the master by more than a frame, and removes the outputs", async () => {
  const { report, files } = await runWork({
    measures: { ...goodMeasures, "teaser-4x5.mp4": { duration: 52.9, width: 1080, height: 1350 } },
  });
  assert.deepEqual(files, ["render-report.json"]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.outputs, {});
  const last = report.steps[report.steps.length - 1];
  assert.equal(last.name, "measure");
  assert.match(last.error, /teaser-4x5\.mp4/);
});

test("measure fails a master outside 45 to 60, and removes the outputs", async () => {
  const { report, files } = await runWork({
    measures: {
      ...goodMeasures,
      "teaser.mp4": { duration: 44.5, width: 1920, height: 1080 },
      "teaser-4x5.mp4": { duration: 44.5, width: 1080, height: 1350 },
    },
  });
  assert.deepEqual(files, ["render-report.json"]);
  assert.match(report.steps[report.steps.length - 1].error, /teaser\.mp4 runs 44\.5 seconds, want 45 to 60/);
});

// Real processes, no render: a child that leaves descendants behind, one of them in a session
// of its own as Remotion's Chromium is.
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

// The pid files are written first, before anything sleeps; the late file comes well after the
// time limit, so a loaded box can neither miss a pid nor see the late write before the kill.
const REAP_LIMIT_MS = 3000;
const LATE_SECONDS = 6;

// A pid file is written under a temporary name and renamed into place, so a pid file that
// exists is always whole: `echo $$ > own.pid` creates the file before it writes, and a kill
// landing between the two left an empty own.pid that no amount of polling would ever fill.
function writePid(pid: string, file: string): string {
  return `echo ${pid} > ${file}.tmp; mv ${file}.tmp ${file}`;
}

function grandchild(dir: string): string {
  return `setsid sh -c '${writePid("$$", `${dir}/own.pid`)}; sleep ${LATE_SECONDS}; touch ${dir}/late'`;
}

function leaver(dir: string): string[] {
  return ["-c", `${grandchild(dir)} & sleep 30 & ${writePid("$!", `${dir}/bg.pid`)}; sleep 30`];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The pid a child wrote, polled for: under load the write can trail the spawn.
async function pidFrom(file: string, waitMs = 2000): Promise<number> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (/^\d+$/.test(text)) return Number(text);
    } catch {
      // Not there yet.
    }
    if (Date.now() > deadline) assert.fail(`${basename(file)} was never written`);
    await sleep(50);
  }
}

// Waits out the late write: LATE_SECONDS after the call started, plus a margin.
const pastLate = (started: number) => sleep(Math.max(0, started + LATE_SECONDS * 1000 + 700 - Date.now()));

test("a timed-out process is killed with every descendant before the call returns", async () => {
  const dir = tempDir("studio-kit-reap-");
  const started = Date.now();
  const result = await runProcess("sh", leaver(dir), { timeoutMs: REAP_LIMIT_MS });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < REAP_LIMIT_MS + 10_000);
  for (const name of ["bg.pid", "own.pid"]) {
    const pid = await pidFrom(join(dir, name));
    assert.equal(running(pid), false, `${name} ${pid} survived`);
  }
  await pastLate(started);
  assert.equal(existsSync(join(dir, "late")), false, "a descendant wrote after the call returned");
});

test("a render step past its time limit fails in the kit's words and leaves nothing running", async () => {
  const dir = tempDir("studio-kit-reap-");
  const fake = fakeRunner({ measures: goodMeasures }, { temp: "" });
  const ws = workspace(["shot-01.webm", "shot-02.webm", "shot-03.webm"]);
  let started = 0;
  const run: Runner = (command, args, options) => {
    if (command !== "npx") return fake(command, args, options);
    started = Date.now();
    return runProcess("sh", leaver(dir), { cwd: options.cwd, timeoutMs: REAP_LIMIT_MS });
  };
  const report = await work(cutScript(clipsCut(15)) as unknown as TeaserProps, ws.clips, ws.out, { run, log: () => {} });
  assert.equal(report.ok, false);
  assert.equal(report.steps[1].name, "render-teaser");
  assert.match(report.steps[1].error, /^rendering Teaser took longer than 15 minutes$/);
  assert.deepEqual(readdirSync(ws.out), ["render-report.json"]);
  for (const name of ["bg.pid", "own.pid"]) {
    const pid = await pidFrom(join(dir, name));
    assert.equal(running(pid), false, `${name} ${pid} survived`);
  }
  await pastLate(started);
  assert.equal(existsSync(join(dir, "late")), false);
});

test("a child that starts a new-session grandchild and exits at once leaves nothing running", async () => {
  const dir = tempDir("studio-kit-reap-");
  const started = Date.now();
  const result = await runProcess(
    "sh",
    ["-c", `${grandchild(dir)} & exit 0`],
    { timeoutMs: 30_000 },
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.status, 0);
  // The grandchild may have been killed before it wrote its pid (then own.pid is absent, never
  // empty: it is renamed into place whole); if it wrote one, it is gone.
  if (existsSync(join(dir, "own.pid"))) {
    const pid = await pidFrom(join(dir, "own.pid"));
    assert.equal(running(pid), false, `grandchild ${pid} survived`);
  }
  await pastLate(started);
  assert.equal(existsSync(join(dir, "late")), false, "the grandchild wrote after the call returned");
  assert.equal(`${result.stdout}${result.stderr}`.includes("STUDIO_KIT_FAMILY"), false);
});

test("a tool that cannot start, or that prints too much, fails in its own words", async () => {
  const missing = await runProcess("studio-kit-no-such-tool", [], { timeoutMs: 5000 });
  assert.equal(missing.failure, "studio-kit-no-such-tool could not be started");
  const loud = await runProcess("sh", ["-c", "head -c 20000000 /dev/zero"], { timeoutMs: 30_000 });
  assert.equal(loud.failure, "sh printed more than 16 MB");
  const fine = await runProcess("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5000 });
  assert.deepEqual(fine, { status: 3, stdout: "out\n", stderr: "err\n", timedOut: false, failure: undefined });
});

test(
  "three whole 15 second clips render a master, a 4:5 reframe and a poster, measured in the report",
  { timeout: 20 * 60 * 1000 },
  (t) => {
    // Never beside the film chapter renders: see tests/fixtures/heavy.ts.
    t.after(holdHeavy());
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
    assert.equal(master.frames, teaserFrames(clips), "the master holds exactly the frames the gate counted");
    assert.ok(master.duration >= 45 && master.duration <= 60);

    const social = probe(join(ws.out, "teaser-4x5.mp4"));
    assert.equal(social.codec, "h264");
    assert.equal(social.width, 1080);
    assert.equal(social.height, 1350);
    assert.equal(social.rate, "30/1");
    assert.ok(Math.abs(social.duration - sum) <= 0.5, `reframe runs ${social.duration}, sum ${sum}`);
    assert.ok(Math.abs(social.duration - master.duration) <= 1 / FPS, `reframe ${social.duration}, master ${master.duration}`);

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
