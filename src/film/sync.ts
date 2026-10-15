import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EXIT, Failed, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, python, refuseReportPaths, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import type { RunResult } from "../render.ts";

// film:sync: is a delivered take a copy of the clean vocal window it was given, and until when
// (claudia.gallery's toolkit wiki, items 15 and 16)? Seedance copies the reference audio into
// its own soundtrack and the mouth follows that soundtrack, so the take's audio (extracted
// with ffmpeg from an MP4, or a WAV) is compared with the window: the global lag within 1 s,
// the take's NCC (a copy over 0.2, else it re-sang), the in-sync spans, where it diverges, and
// the cut on the last eighth note (the beats of beats.json and their midpoints) at or before
// the divergence (the window's start when it diverges before the first eighth). Times are song time: song time = --song-t0 + clip time - lag. Writes
// <take>-sync.png (both spectrograms and the NCC curve) and sync-report.json, whose `sync` is
// the take's sync entry in its clip file. A take that does not copy the window is exit 3.

const COMMAND = "film:sync";
const TIMEOUT_MS = 5 * 60 * 1000; // for ffprobe, ffmpeg and the Python side alike
const THRESHOLD = 0.2;

type Measured = {
  lag_s: number;
  ncc: number;
  frames: Record<string, number>;
  synced: [number, number][];
  diverge_at: number | null;
  missing_tail_s: number;
  curve_t0_s: number;
  judged: number;
  curve: (number | null)[];
  curve_step_s: number;
  png: string;
};

async function tool(command: string, args: string[]): Promise<RunResult> {
  const { runProcess } = await import("../render.ts");
  const result = await runProcess(command, args, { timeoutMs: TIMEOUT_MS });
  if (result.failure) throw new Unexpected(result.failure);
  if (result.timedOut) throw new Unexpected(`${command} took longer than ${TIMEOUT_MS / 60000} minutes`);
  return result;
}

// The file's first audio stream as 16 kHz mono 32-bit float WAV in the temp folder, or the
// refusal line when it has none.
async function decode(file: string, dest: string, refusal: string): Promise<void> {
  const probe = await tool("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
  if (probe.status !== 0 || probe.stdout.trim() !== "audio") throw new Refused([refusal]);
  const result = await tool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", dest]);
  if (result.status !== 0) throw new Refused([refusal]);
}

function readBeats(file: string): number[] {
  try {
    const beats = JSON.parse(readFileSync(file, "utf8"))?.beats;
    if (!Array.isArray(beats) || beats.some((b) => typeof b !== "number" || !Number.isFinite(b))) throw new Error("no beats");
    return [...beats].sort((a, b) => a - b);
  } catch {
    throw new Refused(["--beats is not a beats.json"]);
  }
}

// Eighth notes: the beats and the midpoints between them.
export function eighths(beats: number[]): number[] {
  return beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]) / 2] : [b]));
}

// The cut for a divergence: the last eighth note at or before it; when it diverges before the
// first eighth, the window's start (song time --song-t0, the earliest the take plays), so the
// take is cut before any of it plays rather than left with no cut. No divergence, no cut.
export function cutFor(beats: number[], divergeAt: number | null, songT0: number): number | null {
  if (divergeAt === null) return null;
  return eighths(beats).filter((e) => e <= divergeAt + 1e-9).at(-1) ?? songT0;
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    take: { type: "string" },
    window: { type: "string" },
    beats: { type: "string" },
    "song-t0": { type: "string" },
    out: { type: "string" },
  });
  if (!values.take || !values.window || !values.beats || values["song-t0"] === undefined || !values.out) {
    throw new Refused([`${COMMAND}: --take, --window, --beats, --song-t0 and --out are required`]);
  }
  const songT0Text = values["song-t0"];
  if (!/^\d+(\.\d+)?$/.test(songT0Text)) throw new Refused([`--song-t0 is ${shown(songT0Text)}, want seconds from 0`]);
  const songT0 = Number(songT0Text);
  const take = requireFile(fromCaller(values.take), "--take");
  const windowFile = requireFile(fromCaller(values.window), "--window");
  const beatsFile = requireFile(fromCaller(values.beats), "--beats");
  const beats = readBeats(beatsFile);
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  refuseReportPaths(out, "sync", [["--take", take], ["--window", windowFile], ["--beats", beatsFile]]);
  const stem = basename(take).replace(/\.[^.]*$/, "") || "take";
  const png = `${stem}-sync.png`;

  const temp = mkdtempSync(join(tmpdir(), "studio-kit-sync-"));
  try {
    await decode(take, join(temp, "take.wav"), "--take has no audio stream");
    await decode(windowFile, join(temp, "window.wav"), "--window cannot be read as audio");
    const measured = await python<Measured>(
      "sync",
      [JSON.stringify({ take: join(temp, "take.wav"), window: join(temp, "window.wav"), dest: temp, png: "sync.png" })],
      TIMEOUT_MS,
    );

    const r = (v: number) => Math.round(v * 10000) / 10000;
    const song = (w: number) => r(songT0 + w);
    const mode = measured.ncc > THRESHOLD ? "copy" : "diverged";
    const divergeAt = measured.diverge_at === null ? null : song(measured.diverge_at);
    const cut = cutFor(beats, divergeAt, songT0);
    const sync = {
      lag_s: measured.lag_s,
      ncc: measured.ncc,
      mode,
      synced: measured.synced.map(([a, b]) => [song(a), song(b)]),
      diverge_at: divergeAt,
      cut_at: cut === null ? null : r(cut),
    };

    writeIn(out, png, readFileSync(join(temp, measured.png)));
    writeReport(out, "sync", {
      ok: mode === "copy",
      inputs: { take, window: windowFile, beats: beatsFile, song_t0: songT0 },
      outputs: { png, report: "sync-report.json" },
      sync,
      threshold: THRESHOLD,
      frames: measured.frames,
      judged_windows: measured.judged,
      missing_tail_s: measured.missing_tail_s,
      // The first measured window's start in song time: later than --song-t0 when the take
      // starts inside the window (a negative lag).
      curve: { step_s: measured.curve_step_s, window_s: 0.5, t0: song(measured.curve_t0_s), ncc: measured.curve },
    });
    const name = shown(basename(take));
    if (mode === "diverged") {
      throw new Failed([`sync: ${name} does not copy the window (NCC ${sync.ncc.toFixed(2)}, want over ${THRESHOLD})`]);
    }
    const spans = sync.synced.length === 0 ? "no synced span" : `synced ${sync.synced.map(([a, b]) => `${a.toFixed(2)} to ${b.toFixed(2)}`).join(", ")}`;
    const end = divergeAt === null ? "no divergence" : `diverges at ${divergeAt.toFixed(2)}, cut at ${sync.cut_at === null ? "none" : sync.cut_at.toFixed(2)}`;
    console.log(`sync: ${name} copy, lag ${sync.lag_s.toFixed(2)} s, NCC ${sync.ncc.toFixed(2)}, ${spans}, ${end}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
