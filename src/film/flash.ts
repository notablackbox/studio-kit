import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, python, requireFile, run, writeReport } from "./lib/cli.ts";
import { must, probeVideo } from "./lib/media.ts";

// film:flash: the WCAG 2.3.1 flash check (toolkit item 21). ffmpeg decodes the video at 96x54
// and 24 fps into temp; film_py.flash counts flashes (pairs of opposing luminance transitions of
// 0.1 or more over a quarter of the frame) and single-frame pops (a frame over 0.03 off both
// neighbours the same way). More than three flashes in any one-second window, or any pop, fails
// (exit 3, one line per failing window or pop, the report written with every window and pop).

const COMMAND = "film:flash";
const W = 96;
const H = 54;
const FPS = 24;
const PY_TIMEOUT = 5 * 60 * 1000;

type Result = {
  frames: number;
  mean: number[];
  transitions: unknown[];
  flashes: { frame: number; t: number }[];
  worst: { t0: number; count: number };
  windows: { t0: number; t1: number; flashes: number }[];
  pops: { frame: number; t: number; mean: number; before: number; after: number }[];
  ok: boolean;
};

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { video: { type: "string" }, out: { type: "string" } });
  if (!values.video || !values.out) throw new Refused([`${COMMAND}: --video and --out are required`]);
  const video = requireFile(fromCaller(values.video), "--video");
  const out = fromCaller(values.out);
  const issue = outProblem(out);
  if (issue) throw new Refused([issue]);
  const probe = await probeVideo(video);
  if (!probe) throw new Refused(["--video cannot be read as a video"]);

  const temp = mkdtempSync(join(tmpdir(), "studio-kit-flash-"));
  try {
    const raw = join(temp, "frames.rgb");
    await must("decoding the video", "ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-an", "-vf", `fps=${FPS},scale=${W}:${H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const result = await python<Result>("flash", [JSON.stringify({ raw, width: W, height: H, fps: FPS })], PY_TIMEOUT);
    writeReport(out, "flash", {
      ok: result.ok,
      inputs: { video },
      outputs: { report: "flash-report.json" },
      frames: result.frames,
      seconds: Math.round((result.frames / FPS) * 1000) / 1000,
      rule: { scale: `${W}x${H}`, fps: FPS, transition: 0.1, darker_under: 0.8, area: 0.25, max_flashes_per_second: 3, pop: 0.03 },
      flashes: result.flashes,
      worst_second: result.worst,
      windows: result.windows,
      pops: result.pops,
      transitions: result.transitions,
      mean_luminance: result.mean,
    });
    if (!result.ok) {
      throw new Failed([
        ...result.windows.map((w) => `flash: ${w.flashes} flashes in one second between ${w.t0.toFixed(3)} and ${w.t1.toFixed(3)} s, want at most 3`),
        ...result.pops.map((p) => `flash: a single-frame pop at ${p.t.toFixed(3)} s (frame ${p.frame}): mean luminance ${p.before} -> ${p.mean} -> ${p.after}`),
      ]);
    }
    console.log(`flash: clean, ${result.frames} frames, at most ${result.worst.count} flash${result.worst.count === 1 ? "" : "es"} in any second, no pops`);
    return EXIT.done;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
