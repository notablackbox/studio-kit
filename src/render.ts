import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { FPS, clipFrames, teaserFrames, type TeaserProps } from "./remotion/Teaser.tsx";
import { shown } from "./walk.ts";

// Exit codes: 0 done and report written, 2 refused before any work, 1 anything unexpected.
// Refusals go to stdout, one line per problem, and write nothing at all.

const KIT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ENTRY = "src/remotion/Root.tsx";
const MIN_SECONDS = 45;
const MAX_SECONDS = 60;
const MIN_CLIPS = 3;
const MAX_CLIPS = 5;
const MAX_CAPTION = 60;
// Card text limits, in Unicode characters (code points), so every accepted line fits its card.
const CARD_LIMITS: { field: string; limit: number; read: (raw: Record<string, unknown>) => unknown }[] = [
  { field: "opening.headline", limit: 60, read: (raw) => (isObject(raw.opening) ? raw.opening.headline : undefined) },
  { field: "opening.sub", limit: 80, read: (raw) => (isObject(raw.opening) ? raw.opening.sub : undefined) },
  { field: "proof.line", limit: 80, read: (raw) => (isObject(raw.proof) ? raw.proof.line : undefined) },
  { field: "proof.source", limit: 80, read: (raw) => (isObject(raw.proof) ? raw.proof.source : undefined) },
  { field: "closing.line", limit: 80, read: (raw) => (isObject(raw.closing) ? raw.closing.line : undefined) },
];
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

// Unicode characters, not UTF-16 units: an emoji counts as one.
const characters = (text: string): number => [...text].length;

// A plain name: no folder part, not "." or "..", nothing that could step outside --clips, and
// no control or line-breaking character that could split a printed line.
function isPlainName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)
  );
}

const OUTPUT_NAMES = new Set<string>([...Object.values(OUTPUTS), REPORT]);

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
  for (const { field, limit, read } of CARD_LIMITS) {
    const text = read(raw);
    if (typeof text === "string" && characters(text) > limit) {
      problems.push(`${field} runs ${characters(text)} characters, want at most ${limit}`);
    }
  }

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
      problems.push(`${label}: ${shown(file ?? "")} is not a plain file name inside --clips`);
    } else if (OUTPUT_NAMES.has(file)) {
      problems.push(`${label}: ${shown(file)} is a name render writes in --out`);
    } else if (clipsReal) {
      let inside = false;
      try {
        const real = realpathSync(join(clipsReal, file));
        inside = real.startsWith(clipsReal + sep) && statSync(real).isFile();
      } catch {
        inside = false;
      }
      if (!inside) problems.push(`${label}: ${shown(file)} is not in --clips`);
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
    if (!filled(entry.caption) || characters(entry.caption) > MAX_CAPTION) {
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
// `failure` is set, in the kit's words, when the process could not be run or its output overran.
export type RunResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean; failure?: string };
export type Runner = (command: string, args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<RunResult>;

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const REAP_WAIT_MS = 10_000;
// The name of the environment entry that marks every process of one child's family. Its value
// is a fresh random id per child and is never printed.
const FAMILY_VAR = "STUDIO_KIT_FAMILY";

type Proc = { pid: number; ppid: number; zombie: boolean };

// Every process the system shows, from /proc; null where there is no /proc to read.
function processes(): Proc[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const list: Proc[] = [];
  for (const name of entries) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      list.push({ pid: Number(name), ppid: Number(fields[1]), zombie: fields[0] === "Z" || fields[0] === "X" });
    } catch {
      // Gone between the listing and the read.
    }
  }
  return list;
}

// True when the process's environment holds exactly `entry`. Unreadable (another user's
// process, or gone): false.
function carries(pid: number, entry: Buffer): boolean {
  let environ: Buffer;
  try {
    environ = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return false;
  }
  for (let at = environ.indexOf(entry); at !== -1; at = environ.indexOf(entry, at + 1)) {
    const starts = at === 0 || environ[at - 1] === 0;
    const ends = at + entry.length === environ.length || environ[at + entry.length] === 0;
    if (starts && ends) return true;
  }
  return false;
}

// The child and everything it starts. Each child is spawned with a fresh marker in its
// environment, which every descendant inherits (Chromium in a session of its own included,
// and one reparented to init after its parent exited). The family is every live process that
// carries the marker, and the live descendants of those. A reused pid carries no marker.
class Family {
  private readonly entry: Buffer;
  constructor(readonly root: number, marker: string) {
    this.entry = Buffer.from(`${FAMILY_VAR}=${marker}`);
  }

  members(): number[] | null {
    const all = processes();
    if (!all) return null;
    const live = all.filter((p) => !p.zombie && p.pid !== process.pid);
    // The root while it is still this process's unreaped child is ours even before its exec
    // has put the marker in place; its pid cannot be reused until it is reaped.
    const found = new Set<number>(
      live.filter((p) => (p.pid === this.root && p.ppid === process.pid) || carries(p.pid, this.entry)).map((p) => p.pid),
    );
    let grew = found.size > 0;
    while (grew) {
      grew = false;
      for (const p of live) {
        if (!found.has(p.pid) && found.has(p.ppid)) {
          found.add(p.pid);
          grew = true;
        }
      }
    }
    return [...found];
  }

  killAll(): void {
    const pids = this.members();
    if (pids === null) {
      // No /proc: the process group is the best the system offers.
      try {
        process.kill(-this.root, "SIGKILL");
      } catch {
        // Already gone.
      }
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  alive(): boolean {
    const pids = this.members();
    if (pids !== null) return pids.length > 0;
    try {
      process.kill(-this.root, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Kill everything the child left and wait until none of it runs, so nothing writes into
  // --out after a step has reported.
  async end(): Promise<boolean> {
    const deadline = Date.now() + REAP_WAIT_MS;
    for (;;) {
      this.killAll();
      if (!this.alive()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

export const runProcess: Runner = (command, args, { cwd, timeoutMs }) =>
  new Promise<RunResult>((finish) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let failure: string | undefined;
    let family: Family | undefined;
    let settled = false;

    const marker = randomUUID();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, [FAMILY_VAR]: marker },
    });
    if (child.pid !== undefined) family = new Family(child.pid, marker);
    const timer = setTimeout(() => {
      timedOut = true;
      family?.killAll();
    }, timeoutMs);

    const keep = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        if (!failure) failure = `${command} printed more than ${OUTPUT_LIMIT / 1024 / 1024} MB`;
        family?.killAll();
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));

    const closed = new Promise<void>((done) => child.on("close", () => done()));
    const settle = async (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const gone = family ? await family.end() : true;
      // With the family gone the pipes close; read what is left in them, but never hang on it.
      let cap: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise((done) => (cap = setTimeout(done, 2000)))]);
      clearTimeout(cap);
      if (!gone && !failure && !timedOut) failure = `${command} left processes that would not stop`;
      finish({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        failure,
      });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") failure = `${command} could not be started`;
      else failure = `${command} could not be run (${error.code ?? "unknown error"})`;
      void settle(null);
    });
    // "exit", not "close": a descendant holding the pipes open must not keep the step waiting.
    child.on("exit", (code) => void settle(code));
  });

// A step's failure, in the kit's own words.
class StepFailed extends Error {}

type Tools = { run: Runner; log: (line: string) => void };

async function call(tools: Tools, what: string, command: string, args: string[], timeoutMs: number, cwd?: string) {
  const result = await tools.run(command, args, { cwd, timeoutMs });
  if (result.timedOut) throw new StepFailed(`${what} took longer than ${timeoutMs / MINUTE} minutes`);
  if (result.failure) throw new StepFailed(result.failure);
  if (result.status !== 0) {
    // The tail of the tool's own output, on stderr only, for whoever reads the logs.
    const tail = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.trim() !== "").slice(-20);
    if (tail.length > 0) tools.log(tail.join("\n"));
    throw new StepFailed(`${what} failed`);
  }
  return result;
}

type Probe = { width: number; height: number; fps: number; duration: number };

async function probe(tools: Tools, file: string): Promise<Probe> {
  const result = await call(tools, `ffprobe of ${basename(file)}`, "ffprobe", [
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

async function remotion(tools: Tools, args: string[], what: string, timeoutMs: number) {
  const flags = ["--log=error", `--offthreadvideo-cache-size-in-bytes=${FRAME_CACHE_BYTES}`];
  await call(tools, what, "npx", ["remotion", ...args, ...flags], timeoutMs, KIT_ROOT);
}

async function measureVideo(tools: Tools, out: string, file: string, width: number, height: number): Promise<Video> {
  const p = await probe(tools, join(out, file));
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
export async function work(script: TeaserProps, clipsDir: string, out: string, seam: Partial<Tools> = {}): Promise<Report> {
  const tools: Tools = { run: seam.run ?? runProcess, log: seam.log ?? ((line) => console.error(line)) };
  const used = [...new Set(script.clips.map((clip) => clip.file))];
  const report: Report = { ok: false, date: script.date, steps: [], outputs: {}, clips: used };
  let temp = "";
  let publicDir = "";
  let propsFile = "";

  // Each step catches its own failure, so the chain below never throws.
  const step = async (name: string, body: () => Promise<void>): Promise<boolean> => {
    try {
      await body();
      report.steps.push({ name, ok: true, error: "" });
      return true;
    } catch (error) {
      const message = error instanceof StepFailed ? error.message : "unexpected failure";
      report.steps.push({ name, ok: false, error: message });
      tools.log(`render: ${name}: ${message}`);
      return false;
    }
  };

  const transcode = async () => {
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
      const ffmpeg = await tools.run("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", join(clipsDir, file),
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", String(FPS),
        "-movflags", "+faststart",
        target,
      ], { timeoutMs: TOOL_TIMEOUT });
      if (ffmpeg.timedOut) throw new StepFailed(`transcoding ${file} took longer than ${TOOL_TIMEOUT / MINUTE} minutes`);
      if (ffmpeg.failure) throw new StepFailed(ffmpeg.failure);
      if (ffmpeg.status !== 0) {
        const tail = ffmpeg.stderr.split("\n").filter((line) => line.trim() !== "").slice(-20);
        if (tail.length > 0) tools.log(tail.join("\n"));
        throw new StepFailed(`${file} could not be transcoded`);
      }
      const length = (await probe(tools, target)).duration;
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
  };

  const measure = async () => {
    const teaser = await measureVideo(tools, out, OUTPUTS.teaser, 1920, 1080);
    const teaser4x5 = await measureVideo(tools, out, OUTPUTS.teaser4x5, 1080, 1350);
    const still = await probe(tools, join(out, OUTPUTS.poster));
    if (still.width !== 1920 || still.height !== 1080) {
      throw new StepFailed(`${OUTPUTS.poster} measures ${still.width}x${still.height}, want 1920x1080`);
    }
    if (teaser.durationSeconds < MIN_SECONDS || teaser.durationSeconds > MAX_SECONDS) {
      const shown = shownOutside(teaser.durationSeconds, MIN_SECONDS, MAX_SECONDS);
      throw new StepFailed(`teaser.mp4 runs ${shown} seconds, want ${MIN_SECONDS} to ${MAX_SECONDS}`);
    }
    if (Math.abs(teaser4x5.durationSeconds - teaser.durationSeconds) > 1 / FPS + 0.005) {
      throw new StepFailed(`teaser-4x5.mp4 runs ${teaser4x5.durationSeconds} seconds, the master ${teaser.durationSeconds}`);
    }
    report.outputs = { teaser, teaser4x5, poster: { file: OUTPUTS.poster, width: still.width, height: still.height } };
  };

  mkdirSync(out, { recursive: true });
  try {
    report.ok =
      (await step("transcode", transcode)) &&
      (await step("render-teaser", () =>
        remotion(
          tools,
          ["render", ENTRY, "Teaser", join(out, OUTPUTS.teaser), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering Teaser",
          RENDER_TIMEOUT,
        ),
      )) &&
      (await step("render-teaser-4x5", () =>
        remotion(
          tools,
          ["render", ENTRY, "TeaserSocial", join(out, OUTPUTS.teaser4x5), `--props=${propsFile}`, `--public-dir=${publicDir}`],
          "rendering TeaserSocial",
          RENDER_TIMEOUT,
        ),
      )) &&
      (await step("still-poster", () =>
        remotion(
          tools,
          [
            "still", ENTRY, "Teaser", join(out, OUTPUTS.poster),
            `--props=${propsFile}`, `--public-dir=${publicDir}`, `--frame=${script.posterFrame}`,
          ],
          "rendering the poster still",
          TOOL_TIMEOUT,
        ),
      )) &&
      (await step("measure", measure));
  } finally {
    // Every child process of a step has ended (runProcess waits for its whole family), so
    // nothing writes into --out or the temp folder after this cleanup.
    if (temp) rmSync(temp, { recursive: true, force: true });
    if (!report.ok) {
      removeOutputs(out);
      report.outputs = {};
    }
    writeInOut(out, REPORT, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

// The real path a folder has or would have: the nearest existing ancestor resolved, the rest
// appended, so a symlink cannot hide that two folders are one.
function realFolder(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

const within = (inner: string, outer: string): boolean => {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// --out must be a folder (or not exist yet), and neither --clips nor inside it: render writes
// into --out, and must never write among the clips. A --clips folder below --out is fine
// (`--clips /work/raw/<date> --out /work`): render writes only its fixed names at the top of
// --out, and no clip may carry one of those names.
export function checkOut(out: string, clipsDir: string): string[] {
  try {
    if (existsSync(out) && !statSync(out).isDirectory()) return ["--out is not a folder"];
  } catch {
    return ["--out is not a folder"];
  }
  if (within(realFolder(out), realFolder(clipsDir))) return ["--out must not be the --clips folder or inside it"];
  return [];
}

// Writes a file in --out without following a symlink at its name: the text goes to a fresh
// name first (opened exclusively), then is renamed over the final name, which replaces a link
// rather than writing through it.
function writeInOut(out: string, name: string, text: string): void {
  const temp = join(out, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, join(out, name));
  } finally {
    rmSync(temp, { force: true });
  }
}

async function main(): Promise<number> {
  let values: { script?: string; clips?: string; out?: string };
  try {
    values = parseArgs({
      options: { script: { type: "string" }, clips: { type: "string" }, out: { type: "string" } },
    }).values;
  } catch (error) {
    // The message can quote an argument: keep it on one line.
    console.log(`render: ${shown((error as Error).message).slice(1, -1)}`);
    return 2;
  }
  if (!values.script || !values.clips || !values.out) {
    console.log("render: --script <path>, --clips <dir> and --out <dir> are required");
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
  problems.push(...checkOut(out, clipsDir));
  if (!script || problems.length > 0) {
    for (const problem of problems) console.log(problem);
    return 2;
  }

  const report = await work(script, clipsDir, out);
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // --out could not be made, or the report could not be written.
      console.error("render: unexpected failure");
      process.exitCode = 1;
    },
  );
}
