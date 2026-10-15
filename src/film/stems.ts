import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, Refused, fromCaller, isMain, outProblem, parseFlags, python, requireFile, run, writeIn, writeReport } from "./lib/cli.ts";

// film:stems: splits the master into vocals, drums, bass and other with demucs htdemucs on the
// CPU (four stems, never two). The stems land in <out>/stems/ as 16-bit WAVs; the report gives
// the model and the time taken. The vocal stem feeds film:words and film:window, the drum stem
// film:beats and film:hits, bass and other the impacts and risers.

const COMMAND = "film:stems";
const TIMEOUT_MS = 30 * 60 * 1000;
const STEMS = ["vocals", "drums", "bass", "other"] as const;

type Separated = {
  stems: Record<(typeof STEMS)[number], string>;
  model: { name: string; source: string; device: string; threads: number; shifts: number; overlap: number };
  sample_rate: number;
  channels: number;
  input_rate: number;
  duration: number;
  clipped_samples: Record<string, number>;
  seconds: number;
};

// Renames the folder `from` to `to`. Whatever is at `to` (an earlier run's stems, or a link,
// which is replaced and never followed) is renamed aside first and removed once the new folder
// is in place, or put back if the rename fails.
function swapIn(from: string, to: string): void {
  let present = true;
  try {
    lstatSync(to);
  } catch {
    present = false;
  }
  if (!present) {
    renameSync(from, to);
    return;
  }
  const aside = join(from, "..", `.stems-old-${randomUUID()}`);
  renameSync(to, aside);
  try {
    renameSync(from, to);
  } catch (error) {
    renameSync(aside, to);
    throw error;
  }
  rmSync(aside, { recursive: true, force: true });
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { in: { type: "string" }, out: { type: "string" } });
  if (!values.in || !values.out) throw new Refused([`${COMMAND}: --in <path> and --out <dir> are required`]);
  const input = requireFile(fromCaller(values.in), "--in");
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const started = Date.now();
  // demucs writes into a temp folder; the four stems then go into --out as one unit: written
  // into a fresh staging folder beside <out>/stems, which is renamed into place (an earlier
  // stems folder renamed aside first, then removed). A failure leaves no stem of this run.
  const temp = mkdtempSync(join(tmpdir(), "studio-kit-stems-"));
  let staging: string | null = null;
  try {
    const separated = await python<Separated>("stems", [JSON.stringify({ in: input, dest: temp })], TIMEOUT_MS);
    const outputs: Record<string, string> = {};
    mkdirSync(out, { recursive: true });
    staging = mkdtempSync(join(out, ".stems-"));
    for (const name of STEMS) {
      writeIn(staging, `${name}.wav`, readFileSync(join(temp, separated.stems[name])));
      outputs[name] = `stems/${name}.wav`;
    }
    swapIn(staging, join(out, "stems"));
    staging = null;
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    writeReport(out, "stems", {
      ok: true,
      inputs: { in: input },
      outputs: { stems: outputs, report: "stems-report.json" },
      model: separated.model,
      seconds,
      separation_seconds: separated.seconds,
      sample_rate: separated.sample_rate,
      channels: separated.channels,
      input_rate: separated.input_rate,
      duration: separated.duration,
      clipped_samples: separated.clipped_samples,
    });
    console.log(`stems: 4 stems of ${separated.duration.toFixed(1)} s in ${seconds.toFixed(1)} s (${separated.model.name}, ${separated.model.device})`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
