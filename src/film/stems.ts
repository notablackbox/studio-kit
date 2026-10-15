import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { in: { type: "string" }, out: { type: "string" } });
  if (!values.in || !values.out) throw new Refused([`${COMMAND}: --in <path> and --out <dir> are required`]);
  const input = requireFile(fromCaller(values.in), "--in");
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const started = Date.now();
  // demucs writes into a temp folder; the stems are then moved into --out, each to a fresh name
  // renamed into place, so a failed run leaves no half-written stem behind.
  const temp = mkdtempSync(join(tmpdir(), "studio-kit-stems-"));
  try {
    const separated = await python<Separated>("stems", [JSON.stringify({ in: input, dest: temp })], TIMEOUT_MS);
    const outputs: Record<string, string> = {};
    const bytes = STEMS.map((name) => readFileSync(join(temp, separated.stems[name])));
    STEMS.forEach((name, k) => {
      writeIn(join(out, "stems"), `${name}.wav`, bytes[k]);
      outputs[name] = `stems/${name}.wav`;
    });
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
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
