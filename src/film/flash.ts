import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, python, refuseReportPaths, requireFile, run, writeReport } from "./lib/cli.ts";
import { must, probeVideo } from "./lib/media.ts";

// film:flash: the WCAG 2.3.1 flash check (toolkit item 21). ffmpeg decodes the video at 96x54
// and 24 fps into temp; film_py.flash counts flashes (pairs of opposing luminance transitions:
// per-pixel runs, up and down tracked apart, where a quarter of the pixels changed 0.1 or more,
// darker under 0.8, paired over the same place) and single-frame pops (a frame over 0.03 off both
// neighbours the same way), and red flashes (WCAG's separate rule: pairs of opposing changes, by a
// quarter of the frame or more, in the share of pixels that are saturated red, R / (R + G + B)
// >= 0.8). More than three flashes, or more than three red flashes, in any one-second window fails (exit 3,
// one line per failing window, the report written with every window and pop). A pop is flagged, never
// failed: one `warning:` line per pop on stdout, whatever the exit code.

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
  red: number[];
  red_transitions: unknown[];
  red_flashes: { frame: number; t: number }[];
  red_worst: { t0: number; count: number };
  red_windows: { t0: number; t1: number; flashes: number }[];
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
  refuseReportPaths(out, "flash", [["--video", video]]);
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
      rule: { scale: `${W}x${H}`, fps: FPS, transition: 0.1, darker_under: 0.8, area: 0.25, max_flashes_per_second: 3, pop: 0.03, red: 0.8 },
      flashes: result.flashes,
      worst_second: result.worst,
      windows: result.windows,
      red_flashes: result.red_flashes,
      worst_red_second: result.red_worst,
      red_windows: result.red_windows,
      pops: result.pops,
      transitions: result.transitions,
      red_transitions: result.red_transitions,
      mean_luminance: result.mean,
      red_fraction: result.red,
    });
    const warnings = result.pops.map((p) => `warning: a single-frame pop at ${p.t.toFixed(3)} s (frame ${p.frame}): mean luminance ${p.before} -> ${p.mean} -> ${p.after}`);
    const span = (w: { t0: number; t1: number }) => `between ${w.t0.toFixed(3)} and ${w.t1.toFixed(3)} s, want at most 3`;
    if (!result.ok) {
      throw new Failed([
        ...result.windows.map((w) => `flash: ${w.flashes} flashes in one second ${span(w)}`),
        ...result.red_windows.map((w) => `flash: ${w.flashes} red flashes in one second ${span(w)}`),
        ...warnings,
      ]);
    }
    const pops = result.pops.length;
    const most = result.worst.count;
    const red = result.red_worst.count;
    console.log(
      `flash: clean, ${result.frames} frames, at most ${most} flash${most === 1 ? "" : "es"} and ${red} red flash${red === 1 ? "" : "es"} in any second, ${pops === 0 ? "no pops" : `${pops} pop${pops === 1 ? "" : "s"} flagged`}`,
    );
    for (const line of warnings) console.log(line);
    return EXIT.done;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
