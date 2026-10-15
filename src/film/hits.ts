import { statSync } from "node:fs";
import { EXIT, Refused, fromCaller, isMain, outProblem, parseFlags, python, requireFile, run, writeIn, writeReport } from "./lib/cli.ts";

// film:hits: what the track does, where: kick, snare and hat onsets by band on the drum stem,
// impacts on the mix, drum and bass envelopes, risers, fills (with --beats), the vocal entries
// after silence, and the drum, vocal and bass envelopes at 24 fps. Writes hits.json (the
// formats wiki's shape).

const COMMAND = "film:hits";
const TIMEOUT_MS = 10 * 60 * 1000;

type HitList = {
  kick: number[];
  snare: number[];
  hat: number[];
  hits: { t: number; score: number }[];
  risers: unknown[];
  fills: unknown[];
  vocal_entries: number[];
  env24: Record<string, number[]>;
};
type Found = { hits_json: HitList; used: string[]; absent: string[]; duration: number };

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    stems: { type: "string" },
    mix: { type: "string" },
    out: { type: "string" },
    beats: { type: "string" },
  });
  if (!values.stems || !values.mix || !values.out) {
    throw new Refused([`${COMMAND}: --stems <dir>, --mix <path> and --out <dir> are required`]);
  }
  const stems = fromCaller(values.stems);
  let folder = false;
  try {
    folder = statSync(stems).isDirectory();
  } catch {
    folder = false;
  }
  if (!folder) throw new Refused(["--stems is not a folder"]);
  const mix = requireFile(fromCaller(values.mix), "--mix");
  const beats = values.beats ? requireFile(fromCaller(values.beats), "--beats") : null;
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const found = await python<Found>("hits", [JSON.stringify({ stems, mix, beats })], TIMEOUT_MS);
  const list = found.hits_json;
  writeIn(out, "hits.json", JSON.stringify(list) + "\n");
  writeReport(out, "hits", {
    ok: true,
    inputs: { stems, mix, beats, used: found.used, absent: found.absent },
    outputs: { hits: "hits.json", report: "hits-report.json" },
    duration: found.duration,
    counts: {
      kick: list.kick.length,
      snare: list.snare.length,
      hat: list.hat.length,
      hits: list.hits.length,
      risers: list.risers.length,
      fills: list.fills.length,
      vocal_entries: list.vocal_entries.length,
    },
    hits: list.hits,
  });
  console.log(
    `hits: ${list.kick.length} kicks, ${list.snare.length} snares, ${list.hat.length} hats, ${list.hits.length} hits, ${list.risers.length} risers, ${list.fills.length} fills, ${list.vocal_entries.length} vocal entries`,
  );
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
