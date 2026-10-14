import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { FPS, clipFrames, teaserFrames, type TeaserProps } from "./remotion/Teaser.tsx";

// Exit codes: 0 done and report written, 2 refused before any work, 1 anything unexpected.
// Refusals go to stdout, one line per problem, and write nothing at all.

const KIT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ENTRY = "src/remotion/Root.tsx";
const MIN_SECONDS = 45;
const MAX_SECONDS = 60;
const MIN_CLIPS = 3;
const MAX_CLIPS = 5;
const MAX_CAPTION = 60;
const OUTPUTS = { teaser: "teaser.mp4", teaser4x5: "teaser-4x5.mp4", poster: "poster.png" };
const REPORT = "render-report.json";
const MINUTE = 60 * 1000;
const RENDER_TIMEOUT = 15 * MINUTE;
const TOOL_TIMEOUT = 5 * MINUTE;

type Step = { name: string; ok: boolean; error: string };
type Video = { file: string; durationSeconds: number; width: number; height: number; fps: number };
export type Report = {
  ok: boolean;
  date: string;
  steps: Step[];
  outputs: { teaser?: Video; teaser4x5?: Video; poster?: { file: string; width: number; height: number } };
  clips: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// A plain name: no folder part, not "." or "..", nothing that could step outside --clips.
function isPlainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

// Seconds to one decimal, rounded away from the range they fall outside, so a line never
// names a value inside the range it refuses (44.97 shows 44.9, 60.03 shows 60.1).
function shownOutside(seconds: number, low: number, high: number): string {
  const tenths = seconds * 10;
  if (seconds < low) return (Math.floor(tenths + 1e-9) / 10).toFixed(1);
  if (seconds > high) return (Math.ceil(tenths - 1e-9) / 10).toFixed(1);
  return (Math.round(tenths) / 10).toFixed(1);
}

// Returns the script when it is valid, else one problem per entry.
export function validateScript(raw: unknown, clipsDir: string): { script?: TeaserProps; problems: string[] } {
  if (!isObject(raw)) return { problems: ["cut script is not a JSON object"] };
  const problems: string[] = [];
  if (!isIsoDate(raw.date)) problems.push("date must be a real date written YYYY-MM-DD");
  if (typeof raw.title !== "string") problems.push("title is missing");
  if (!isObject(raw.opening) || !filled(raw.opening.headline) || !filled(raw.opening.sub)) {
    problems.push("opening needs a headline and a sub");
  }
  if (!isObject(raw.proof) || !filled(raw.proof.line) || !filled(raw.proof.source)) {
    problems.push("proof needs a line and a source");
  }
  if (!isObject(raw.closing) || !filled(raw.closing.line)) problems.push("closing needs a line");

  if (!Array.isArray(raw.clips)) return { problems: [...problems, "clips is not a list"] };
  const clips = raw.clips as unknown[];
  let clipsReal = "";
  try {
    clipsReal = realpathSync(clipsDir);
    if (!statSync(clipsReal).isDirectory()) clipsReal = "";
  } catch {
    clipsReal = "";
  }
  if (!clipsReal) problems.push("--clips is not a folder");
  const countOk = clips.length >= MIN_CLIPS && clips.length <= MAX_CLIPS;
  if (!countOk) problems.push(`script has ${clips.length} clips, want ${MIN_CLIPS} to ${MAX_CLIPS}`);

  let timingOk = true;
  clips.forEach((entry, index) => {
    const label = `clip ${index + 1}`;
    if (!isObject(entry)) {
      problems.push(`${label}: not an object`);
      timingOk = false;
      return;
    }
    const file = entry.file;
    if (typeof file !== "string" || !isPlainName(file)) {
      problems.push(`${label}: ${JSON.stringify(file ?? "")} is not a plain file name inside --clips`);
    } else if (clipsReal) {
      let inside = false;
      try {
        const real = realpathSync(join(clipsReal, file));
        inside = real.startsWith(clipsReal + sep) && statSync(real).isFile();
      } catch {
        inside = false;
      }
      if (!inside) problems.push(`${label}: ${file} is not in --clips`);
    }
    const start = entry.in;
    const end = entry.out;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) {
      problems.push(`${label}: in must be a number of seconds, 0 or more`);
      timingOk = false;
    } else if (typeof end !== "number" || !Number.isFinite(end) || end <= start) {
      problems.push(`${label}: out must be after in`);
      timingOk = false;
    } else if (clipFrames({ in: start, out: end }) < FPS) {
      const seconds = clipFrames({ in: start, out: end }) / FPS;
      problems.push(`${label}: runs ${shownOutside(seconds, 1, Infinity)} seconds, want at least 1`);
      timingOk = false;
    }
    if (!filled(entry.caption) || entry.caption.length > MAX_CAPTION) {
      problems.push(`${label}: caption must be 1 to ${MAX_CAPTION} characters`);
    }
  });

  if (countOk && timingOk) {
    const timed = clips as { in: number; out: number }[];
    // The gate counts whole frames, exactly as the composition will, so a master it lets
    // through measures what was counted.
    const frames = teaserFrames(timed);
    if (frames < MIN_SECONDS * FPS || frames > MAX_SECONDS * FPS) {
      const shown = shownOutside(frames / FPS, MIN_SECONDS, MAX_SECONDS);
      problems.push(`script runs ${shown} seconds, want ${MIN_SECONDS} to ${MAX_SECONDS}`);
    } else {
      const poster = raw.posterFrame;
      if (typeof poster !== "number" || !Number.isInteger(poster) || poster < 0 || poster >= frames) {
        problems.push(`posterFrame must be a whole frame from 0 to ${frames - 1}`);
      }
    }
  }

  if (problems.length > 0) return { problems };
  return { script: raw as unknown as TeaserProps, problems };
}

// The seam to the outside world: one child process, run to the end or to its time limit.
export type Runner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => { status: number | null; stdout: string; stderr: string; timedOut: boolean };

const spawnRunner: Runner = (command, args, { cwd, timeoutMs }) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (result.error && !timedOut) throw new StepFailed(`${command} could not be started`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut };
};

// A step's failure, in the kit's own words.
class StepFailed extends Error {}

type Tools = { run: Runner; log: (line: string) => void };

function call(tools: Tools, what: string, command: string, args: string[], timeoutMs: number, cwd?: string) {
  const result = tools.run(command, args, { cwd, timeoutMs });
  if (result.timedOut) throw new StepFailed(`${what} took longer than ${timeoutMs / MINUTE} minutes`);
  if (result.status !== 0) {
    // The tail of the tool's own output, on stderr only, for whoever reads the logs.
    const tail = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.trim() !== "").slice(-20);
    if (tail.length > 0) tools.log(tail.join("\n"));
    throw new StepFailed(`${what} failed`);
  }
  return result;
}

type Probe = { width: number; height: number; fps: number; duration: number };

function probe(tools: Tools, file: string): Probe {
  const result = call(tools, `ffprobe of ${basename(file)}`, "ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json",
    file,
  ], TOOL_TIMEOUT);
  let parsed: { streams?: Record<string, unknown>[]; format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new StepFailed(`ffprobe could not read ${basename(file)}`);
  }
  const stream = parsed.streams?.[0] ?? {};
  const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
    duration: Number(parsed.format?.duration),
  };
}

// Remotion's own default for the OffthreadVideo frame cache is half the memory free when the
// render starts; next to Chromium and the encoder that ran a 6 GB box out of memory. A fixed
// 512 MB holds well over a second of 1080p frames, all one clip ever looks back on.
const FRAME_CACHE_BYTES = 512 * 1024 * 1024;

function remotion(tools: Tools, args: string[], what: string, timeoutMs: number) {
  const flags = ["--log=error", `--offthreadvideo-cache-size-in-bytes=${FRAME_CACHE_BYTES}`];
  call(tools, what, "npx", ["remotion", ...args, ...flags], timeoutMs, KIT_ROOT);
}

function measureVideo(tools: Tools, out: string, file: string, width: number, height: number): Video {
  const p = probe(tools, join(out, file));
  if (p.width !== width || p.height !== height) {
    throw new StepFailed(`${file} measures ${p.width}x${p.height}, want ${width}x${height}`);
  }
  if (p.fps !== FPS) throw new StepFailed(`${file} runs at ${p.fps} fps, want ${FPS}`);
  if (!Number.isFinite(p.duration)) throw new StepFailed(`${file} has no duration`);
  return { file, durationSeconds: Math.round(p.duration * 100) / 100, width, height, fps: p.fps };
}

const removeOutputs = (out: string) => {
  for (const name of Object.values(OUTPUTS)) rmSync(join(out, name), { force: true });
};

// The work after the gate. Writes render-report.json once it has started, on success and on
// failure; a failed run leaves the report alone in --out, with no outputs listed.
export function work(script: TeaserProps, clipsDir: string, out: string, seam: Partial<Tools> = {}): Report {
  const tools: Tools = { run: seam.run ?? spawnRunner, log: seam.log ?? ((line) => console.error(line)) };
  const used = [...new Set(script.clips.map((clip) => clip.file))];
  const report: Report = { ok: false, date: script.date, steps: [], outputs: {}, clips: used };
  let temp = "";

  const step = (name: string, body: () => void): boolean => {
    try {
      body();
      report.steps.push({ name, ok: true, error: "" });
      return true;
    } catch (error) {
      const message = error instanceof StepFailed ? error.message : "unexpected failure";
      report.steps.push({ name, ok: false, error: message });
      tools.log(`render: ${name}: ${message}`);
      return false;
    }
  };

  mkdirSync(out, { recursive: true });
  try {
    let publicDir = "";
    let propsFile = "";
    report.ok =
      step("transcode", () => {
        removeOutputs(out);
        try {
          temp = mkdtempSync(join(tmpdir(), "studio-kit-render-"));
          publicDir = join(temp, "public");
          propsFile = join(temp, "props.json");
          mkdirSync(publicDir);
        } catch {
          throw new StepFailed("the temp folder could not be made");
        }
        const names = new Map<string, string>();
        used.forEach((file, i) => names.set(file, `clip-${String(i + 1).padStart(2, "0")}.mp4`));
        for (const file of used) {
          const target = join(publicDir, names.get(file)!);
          const ffmpeg = tools.run("ffmpeg", [
            "-y", "-loglevel", "error",
            "-i", join(clipsDir, file),
            "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", String(FPS),
            "-movflags", "+faststart",
            target,
          ], { timeoutMs: TOOL_TIMEOUT });
          if (ffmpeg.timedOut) throw new StepFailed(`transcoding ${file} took longer than ${TOOL_TIMEOUT / MINUTE} minutes`);
          if (ffmpeg.status !== 0) {
            const tail = ffmpeg.stderr.split("\n").filter((line) => line.trim() !== "").slice(-20);
            if (tail.length > 0) tools.log(tail.join("\n"));
            throw new StepFailed(`${file} could not be transcoded`);
          }
          const length = probe(tools, target).duration;
          const latest = Math.max(...script.clips.filter((clip) => clip.file === file).map((clip) => clip.out));
          if (!(length + 1 / FPS >= latest)) {
            throw new StepFailed(`${file} runs ${length.toFixed(2)} seconds, a clip wants it to ${latest.toFixed(2)}`);
          }
        }
        const props: TeaserProps = {
          ...script,
          clips: script.clips.map((clip) => ({ ...clip, file: names.get(clip.file)! })),
        };
        writeFileSync(propsFile, JSON.stringify(props));
      }) &&
      step("render-teaser", () => {
        remotion(
          tools,
          ["render", ENTRY, "Teaser", join(out, OUTPUTS.teaser), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering Teaser",
          RENDER_TIMEOUT,
        );
      }) &&
      step("render-teaser-4x5", () => {
        remotion(
          tools,
          ["render", ENTRY, "TeaserSocial", join(out, OUTPUTS.teaser4x5), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering TeaserSocial",
          RENDER_TIMEOUT,
        );
      }) &&
      step("still-poster", () => {
        remotion(
          tools,
          [
            "still", ENTRY, "Teaser", join(out, OUTPUTS.poster),
            `--props=${propsFile}`, `--public-dir=${publicDir}`, `--frame=${script.posterFrame}`,
          ],
          "rendering the poster still",
          TOOL_TIMEOUT,
        );
      }) &&
      step("measure", () => {
        const teaser = measureVideo(tools, out, OUTPUTS.teaser, 1920, 1080);
        const teaser4x5 = measureVideo(tools, out, OUTPUTS.teaser4x5, 1080, 1350);
        const still = probe(tools, join(out, OUTPUTS.poster));
        if (still.width !== 1920 || still.height !== 1080) {
          throw new StepFailed(`${OUTPUTS.poster} measures ${still.width}x${still.height}, want 1920x1080`);
        }
        if (teaser.durationSeconds < MIN_SECONDS || teaser.durationSeconds > MAX_SECONDS) {
          const shown = shownOutside(teaser.durationSeconds, MIN_SECONDS, MAX_SECONDS);
          throw new StepFailed(`teaser.mp4 runs ${shown} seconds, want ${MIN_SECONDS} to ${MAX_SECONDS}`);
        }
        if (Math.abs(teaser4x5.durationSeconds - teaser.durationSeconds) > 1 / FPS + 0.005) {
          throw new StepFailed(
            `teaser-4x5.mp4 runs ${teaser4x5.durationSeconds} seconds, the master ${teaser.durationSeconds}`,
          );
        }
        report.outputs = { teaser, teaser4x5, poster: { file: OUTPUTS.poster, width: still.width, height: still.height } };
      });
  } catch {
    report.ok = false;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    if (!report.ok) {
      removeOutputs(out);
      report.outputs = {};
    }
    writeFileSync(join(out, REPORT), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

function main(): number {
  let values: { script?: string; clips?: string; out?: string };
  try {
    values = parseArgs({
      options: { script: { type: "string" }, clips: { type: "string" }, out: { type: "string" } },
    }).values;
  } catch (error) {
    console.error(`render: ${(error as Error).message}`);
    return 2;
  }
  if (!values.script || !values.clips || !values.out) {
    console.error("render: --script <path>, --clips <dir> and --out <dir> are required");
    return 2;
  }

  const base = process.env.INIT_CWD || process.cwd();
  const clipsDir = resolve(base, values.clips);
  const out = resolve(base, values.out);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(base, values.script), "utf8"));
  } catch {
    console.log("cut script cannot be read as JSON");
    return 2;
  }
  const { script, problems } = validateScript(raw, clipsDir);
  if (!script) {
    for (const problem of problems) console.log(problem);
    return 2;
  }
  if (existsSync(out) && !statSync(out).isDirectory()) {
    console.log("--out is not a folder");
    return 2;
  }

  const report = work(script, clipsDir, out);
  return report.ok ? 0 : 1;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main();
  } catch {
    console.error("render: unexpected failure");
    process.exitCode = 1;
  }
}
