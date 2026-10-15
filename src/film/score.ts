import { statSync } from "node:fs";
import { EXIT, Refused, fromCaller, isMain, outProblem, parseFlags, python, refuseReportPaths, run, writeReport } from "./lib/cli.ts";

// film:score: scores a lyric sheet before any take is spent. Per line: syllables and stresses
// from the CMU dictionary (a letter-group fallback for words it lacks), a scansion score; per
// section and overall: scansion and assonance, 0 to 100. Lints spoken lines outside 10 to 13
// syllables, digits and all-caps acronyms. The scores are a diagnostic, never a gate: exit 0
// with the report, or 2 when the sheet cannot be scored.

const COMMAND = "film:score";
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 2 * 60 * 1000;

type Lint = { line: number; kind: string; message: string };
type Scored = { lines: unknown[]; sections: unknown[]; scansion: number; assonance: number; lint: Lint[] };

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { lyrics: { type: "string" }, out: { type: "string" } });
  if (!values.lyrics || !values.out) throw new Refused([`${COMMAND}: --lyrics <path> and --out <dir> are required`]);
  const lyrics = fromCaller(values.lyrics);
  const out = fromCaller(values.out);

  let size: number;
  try {
    const stat = statSync(lyrics);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new Refused(["lyrics file cannot be read"]);
  }
  if (size > MAX_BYTES) throw new Refused(["lyrics file is over 64 KB"]);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  refuseReportPaths(out, "score", [["--lyrics", lyrics]]);

  // The Python side reads the sheet and refuses one with no lyric line; it writes nothing.
  const scored = await python<Scored>("score", [lyrics], TIMEOUT_MS);
  writeReport(out, "score", { ok: true, inputs: { lyrics }, outputs: { report: "score-report.json" }, ...scored });

  console.log(
    `score: ${scored.lines.length} lines in ${scored.sections.length} sections, scansion ${scored.scansion}, assonance ${scored.assonance}, ${scored.lint.length} lint`,
  );
  for (const lint of scored.lint) console.log(lint.message);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
