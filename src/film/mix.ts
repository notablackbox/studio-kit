import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, Failed, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { audioSeconds, must, tool } from "./lib/media.ts";
import { SOUNDS, type SoundKind } from "../remotion/film/plan.ts";

// film:mix: the song with the picture's sound layer (motion wiki, "Re-cue the sound layer";
// toolkit item 25). The master plus each event of the chapters' `<chapter>.audio.json` (a short
// synthesised sound per kind from --sounds: tick, stamp, type, whoosh, made by
// film_py/sounds.py), the events bus ducked under the vocal stem with ffmpeg's
// sidechaincompress, then brought to the master's own integrated loudness (EBU R128, measured
// with ebur128) and written as `mix.wav`, 48 kHz 24-bit. The report holds the master's and the
// mix's loudness; a mix more than 1 LU from the master's fails (exit 3). An event outside the
// master's length is refused (exit 2).

const COMMAND = "film:mix";
const RATE = 48000;
const TOLERANCE_LU = 1;

type Event = { t: number; kind: SoundKind; gain: number; from: string };

async function loudness(file: string): Promise<{ integrated: number; range: number; peak: number | null }> {
  const result = await tool("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]);
  if (result.status !== 0) throw new Unexpected(`measuring the loudness of ${file.split("/").pop()} failed`);
  const summary = result.stderr.slice(result.stderr.lastIndexOf("Summary:"));
  const i = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary);
  const lra = /LRA:\s+(-?[\d.]+) LU/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  if (!i || i[1] === "-inf") throw new Unexpected(`the loudness of ${file.split("/").pop()} could not be measured`);
  return { integrated: Number(i[1]), range: lra ? Number(lra[1]) : 0, peak: peak && peak[1] !== "-inf" ? Number(peak[1]) : null };
}

function readEvents(files: string[], duration: number): { events: Event[]; problems: string[] } {
  const events: Event[] = [];
  const problems: string[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(requireFile(file, "--events"), "utf8"));
    } catch (error) {
      if (error instanceof Refused) throw error;
      problems.push(`--events: ${shown(file.split("/").pop())} is not JSON`);
      continue;
    }
    if (!Array.isArray(raw)) {
      problems.push(`--events: ${shown(file.split("/").pop())} is not a list of events`);
      continue;
    }
    raw.forEach((e, n) => {
      const at = `--events: ${shown(file.split("/").pop())}[${n}]`;
      const obj = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
      const t = obj.t;
      const kind = obj.kind;
      const gain = obj.gain ?? 1;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return void problems.push(`${at} has no time (t, in song seconds)`);
      if (!(SOUNDS as readonly unknown[]).includes(kind)) return void problems.push(`${at} kind ${shown(kind)} is not one of ${SOUNDS.join(", ")}`);
      if (typeof gain !== "number" || !(gain >= 0 && gain <= 2)) return void problems.push(`${at} gain ${shown(gain)} is not 0 to 2`);
      if (t >= duration) return void problems.push(`${at} at ${t.toFixed(3)} s is outside the master (${duration.toFixed(3)} s)`);
      events.push({ t, kind: kind as SoundKind, gain, from: file });
    });
  }
  return { events: events.sort((a, b) => a.t - b.t), problems };
}

async function main(): Promise<number> {
  // `--events a.audio.json b.audio.json`: the files after the first are positionals.
  const { values, positionals } = parseFlags(
    COMMAND,
    { master: { type: "string" }, events: { type: "string", multiple: true }, vocals: { type: "string" }, sounds: { type: "string" }, out: { type: "string" } },
    process.argv.slice(2),
    true,
  );
  const eventFiles = [...(values.events ?? []), ...positionals].map(fromCaller);
  if (!values.master || eventFiles.length === 0 || !values.vocals || !values.sounds || !values.out) {
    throw new Refused([`${COMMAND}: --master, --events, --vocals, --sounds and --out are required`]);
  }
  const master = requireFile(fromCaller(values.master), "--master");
  const vocals = requireFile(fromCaller(values.vocals), "--vocals");
  const soundsDir = fromCaller(values.sounds);
  try {
    if (!statSync(soundsDir).isDirectory()) throw new Error();
  } catch {
    throw new Refused(["--sounds is not a folder"]);
  }
  const duration = await audioSeconds(master);
  if (duration === null) throw new Refused(["--master cannot be read as audio"]);
  if ((await audioSeconds(vocals)) === null) throw new Refused(["--vocals cannot be read as audio"]);
  const { events, problems } = readEvents(eventFiles, duration);
  const kinds = [...new Set(events.map((e) => e.kind))];
  for (const kind of kinds) {
    try {
      requireFile(join(soundsDir, `${kind}.wav`), "--sounds");
    } catch {
      problems.push(`--sounds has no ${kind}.wav (make them with python3 -I src/film/py/film_py/sounds.py --dest <folder>)`);
    }
  }
  const out = fromCaller(values.out);
  const issue = outProblem(out);
  if (issue) problems.push(issue);
  if (problems.length > 0) throw new Refused(problems);

  const temp = mkdtempSync(join(tmpdir(), "studio-kit-mix-"));
  try {
    const target = await loudness(master);
    const inputs = ["-i", master, "-i", vocals, ...kinds.flatMap((k) => ["-i", join(soundsDir, `${k}.wav`)])];
    const fmt = `aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo`;
    const graph: string[] = [`[0:a]${fmt}[master]`, `[1:a]${fmt}[vox]`];
    const labels: string[] = [];
    kinds.forEach((kind, k) => {
      const mine = events.filter((e) => e.kind === kind);
      const splits = mine.map((_, n) => `[s${k}_${n}]`).join("");
      graph.push(`[${k + 2}:a]${fmt},asplit=${mine.length}${splits}`);
      mine.forEach((e, n) => {
        const ms = Math.round(e.t * 1000);
        graph.push(`[s${k}_${n}]adelay=${ms}|${ms},volume=${e.gain.toFixed(4)}[e${k}_${n}]`);
        labels.push(`[e${k}_${n}]`);
      });
    });
    const raw = join(temp, "raw.wav");
    if (labels.length > 0) {
      graph.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad=whole_dur=${duration.toFixed(3)}[events]`);
      // The events duck under her voice: the vocal stem keys a fast compressor on the bus.
      graph.push(`[events][vox]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=250:makeup=1[ducked]`);
      graph.push(`[master][ducked]amix=inputs=2:normalize=0:duration=first[mix]`);
    } else {
      graph.push(`[master]anull[mix]`);
    }
    await must("mixing", "ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "[mix]", "-c:a", "pcm_f32le", "-ar", String(RATE), raw]);
    const before = await loudness(raw);
    const gain = target.integrated - before.integrated;
    await must("levelling the mix", "ffmpeg", [
      "-y", "-loglevel", "error", "-i", raw,
      "-af", `volume=${gain.toFixed(3)}dB,alimiter=limit=0.977:attack=2:release=50:level=disabled`,
      "-c:a", "pcm_s24le", "-ar", String(RATE), join(temp, "mix.wav"),
    ]);
    const after = await loudness(join(temp, "mix.wav"));
    writeIn(out, "mix.wav", readFileSync(join(temp, "mix.wav")));
    const delta = Math.round((after.integrated - target.integrated) * 100) / 100;
    const ok = Math.abs(delta) <= TOLERANCE_LU;
    writeReport(out, "mix", {
      ok,
      inputs: { master, vocals, sounds: soundsDir, events: eventFiles },
      outputs: { mix: "mix.wav", report: "mix-report.json" },
      format: { rate: RATE, bits: 24, channels: 2 },
      seconds: Math.round(duration * 1000) / 1000,
      events: events.map((e) => ({ t: e.t, kind: e.kind, gain: e.gain })),
      ducking: { sidechain: "vocals", threshold: 0.02, ratio: 8, attack_ms: 5, release_ms: 250 },
      loudness: { target_lufs: target.integrated, master: target, before_levelling: before, mix: after, gain_db: Math.round(gain * 100) / 100, delta_lu: delta, tolerance_lu: TOLERANCE_LU },
    });
    if (!ok) throw new Failed([`mix: ${after.integrated} LUFS, the master ${target.integrated} LUFS (${delta} LU off, want within ${TOLERANCE_LU})`]);
    console.log(`mix: ${events.length} event${events.length === 1 ? "" : "s"} under the master, ${after.integrated} LUFS (the master ${target.integrated} LUFS, ${delta >= 0 ? "+" : ""}${delta} LU), mix.wav 48 kHz 24-bit`);
    return EXIT.done;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
