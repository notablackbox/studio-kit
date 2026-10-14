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
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { FPS, scriptSeconds, teaserFrames, type TeaserProps } from "./remotion/Teaser.tsx";

// Exit codes: 0 done and report written, 2 refused before any work, 1 anything unexpected.
// Refusals go to stdout, one line per problem, and write nothing at all.

const KIT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ENTRY = "src/remotion/Root.tsx";
const MIN_SECONDS = 45;
const MAX_SECONDS = 60;
const MIN_CLIPS = 3;
const MAX_CLIPS = 5;
const MAX_CAPTION = 60;
const OUTPUTS = { teaser: "teaser.mp4", teaser4x5: "teaser-4x5.mp4", poster: "poster.png", report: "render-report.json" };

type Step = { name: string; ok: boolean; error: string };
type Video = { file: string; durationSeconds: number; width: number; height: number; fps: number };
type Report = {
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

const oneDecimal = (seconds: number) => (Math.round(seconds * 10) / 10).toFixed(1);

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
    } else if (end - start < 1) {
      problems.push(`${label}: runs ${oneDecimal(end - start)} seconds, want at least 1`);
      timingOk = false;
    }
    if (!filled(entry.caption) || entry.caption.length > MAX_CAPTION) {
      problems.push(`${label}: caption must be 1 to ${MAX_CAPTION} characters`);
    }
  });

  if (countOk && timingOk) {
    const timed = clips as { in: number; out: number }[];
    // Rounded to a microsecond so float noise never moves a script across 45 or 60.
    const seconds = Math.round(scriptSeconds(timed) * 1e6) / 1e6;
    if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      problems.push(`script runs ${oneDecimal(seconds)} seconds, want ${MIN_SECONDS} to ${MAX_SECONDS}`);
    } else {
      const frames = teaserFrames(timed);
      const poster = raw.posterFrame;
      if (typeof poster !== "number" || !Number.isInteger(poster) || poster < 0 || poster >= frames) {
        problems.push(`posterFrame must be a whole frame from 0 to ${frames - 1}`);
      }
    }
  }

  if (problems.length > 0) return { problems };
  return { script: raw as unknown as TeaserProps, problems };
}

// A step's failure, in the kit's own words.
class StepFailed extends Error {}

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new StepFailed(`${command} could not be started`);
  return result;
}

// The tail of a tool's own output, on stderr only, for whoever reads the logs.
function echoTail(text: string) {
  const tail = text.split("\n").filter((line) => line.trim() !== "").slice(-20);
  if (tail.length > 0) console.error(tail.join("\n"));
}

type Probe = { width: number; height: number; fps: number; duration: number };

function probe(file: string): Probe {
  const result = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json",
    file,
  ]);
  if (result.status !== 0) throw new StepFailed(`ffprobe could not read ${file.split(sep).pop()}`);
  const parsed = JSON.parse(result.stdout);
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

function remotion(args: string[], what: string) {
  const flags = ["--log=error", `--offthreadvideo-cache-size-in-bytes=${FRAME_CACHE_BYTES}`];
  const result = run("npx", ["remotion", ...args, ...flags], KIT_ROOT);
  if (result.status !== 0) {
    echoTail(`${result.stdout}\n${result.stderr}`);
    throw new StepFailed(`${what} failed`);
  }
}

function measureVideo(out: string, file: string, width: number, height: number): Video {
  const p = probe(join(out, file));
  if (p.width !== width || p.height !== height) {
    throw new StepFailed(`${file} measures ${p.width}x${p.height}, want ${width}x${height}`);
  }
  if (p.fps !== FPS) throw new StepFailed(`${file} runs at ${p.fps} fps, want ${FPS}`);
  if (!Number.isFinite(p.duration)) throw new StepFailed(`${file} has no duration`);
  return { file, durationSeconds: Math.round(p.duration * 100) / 100, width, height, fps: p.fps };
}

function work(script: TeaserProps, clipsDir: string, out: string): Report {
  const used = [...new Set(script.clips.map((clip) => clip.file))];
  const report: Report = { ok: false, date: script.date, steps: [], outputs: {}, clips: used };

  mkdirSync(out, { recursive: true });
  for (const name of Object.values(OUTPUTS)) rmSync(join(out, name), { force: true });
  const temp = mkdtempSync(join(tmpdir(), "studio-kit-render-"));
  const publicDir = join(temp, "public");
  const propsFile = join(temp, "props.json");

  const step = (name: string, body: () => void): boolean => {
    try {
      body();
      report.steps.push({ name, ok: true, error: "" });
      return true;
    } catch (error) {
      const message = error instanceof StepFailed ? error.message : "unexpected failure";
      report.steps.push({ name, ok: false, error: message });
      console.error(`render: ${name}: ${message}`);
      return false;
    }
  };

  try {
    mkdirSync(publicDir);
    const ok =
      step("transcode", () => {
        const names = new Map<string, string>();
        used.forEach((file, i) => names.set(file, `clip-${String(i + 1).padStart(2, "0")}.mp4`));
        for (const file of used) {
          const target = join(publicDir, names.get(file)!);
          const ffmpeg = run("ffmpeg", [
            "-y", "-loglevel", "error",
            "-i", join(clipsDir, file),
            "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", String(FPS),
            "-movflags", "+faststart",
            target,
          ]);
          if (ffmpeg.status !== 0) {
            echoTail(ffmpeg.stderr);
            throw new StepFailed(`${file} could not be transcoded`);
          }
          const length = probe(target).duration;
          const latest = Math.max(...script.clips.filter((clip) => clip.file === file).map((clip) => clip.out));
          if (!(length + 1 / FPS >= latest)) {
            throw new StepFailed(`${file} runs ${oneDecimal(length)} seconds, a clip wants it to ${oneDecimal(latest)}`);
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
          ["render", ENTRY, "Teaser", join(out, OUTPUTS.teaser), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering Teaser",
        );
      }) &&
      step("render-teaser-4x5", () => {
        remotion(
          ["render", ENTRY, "TeaserSocial", join(out, OUTPUTS.teaser4x5), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering TeaserSocial",
        );
      }) &&
      step("still-poster", () => {
        remotion(
          [
            "still", ENTRY, "Teaser", join(out, OUTPUTS.poster),
            `--props=${propsFile}`, `--public-dir=${publicDir}`, `--frame=${script.posterFrame}`,
          ],
          "rendering the poster still",
        );
      }) &&
      step("measure", () => {
        const teaser = measureVideo(out, OUTPUTS.teaser, 1920, 1080);
        const teaser4x5 = measureVideo(out, OUTPUTS.teaser4x5, 1080, 1350);
        const still = probe(join(out, OUTPUTS.poster));
        if (still.width !== 1920 || still.height !== 1080) {
          throw new StepFailed(`${OUTPUTS.poster} measures ${still.width}x${still.height}, want 1920x1080`);
        }
        report.outputs = { teaser, teaser4x5, poster: { file: OUTPUTS.poster, width: still.width, height: still.height } };
        if (teaser.durationSeconds < MIN_SECONDS || teaser.durationSeconds > MAX_SECONDS) {
          throw new StepFailed(`teaser.mp4 runs ${oneDecimal(teaser.durationSeconds)} seconds, want ${MIN_SECONDS} to ${MAX_SECONDS}`);
        }
      });
    report.ok = ok;
  } finally {
    rmSync(temp, { recursive: true, force: true });
    writeFileSync(join(out, OUTPUTS.report), JSON.stringify(report, null, 2) + "\n");
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
