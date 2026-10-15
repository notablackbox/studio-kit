import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, printable, python, requireFile, run, writeIn, writeReport } from "./lib/cli.ts";

// film:words: a time for every sung word. Forced alignment of the lyric sheet on the vocal
// stem (torchaudio's wav2vec2 MMS_FA), faster-whisper tiny for the words the aligner is unsure
// of, an even share of the gap for the rest; `conf` and `src` per word, lines and long gaps,
// and an ear-check list of at most five spots. With --display, each display line must consume
// exactly its lyric line's words. Exit 3 when fewer than 90 percent of the words are within
// 0.10 s of --expect's times, or, without --expect, have a confidence of 0.5 or more. That gate
// is fixed: --min-conf only sets which words go to the fallback.

const COMMAND = "film:words";
const TIMEOUT_MS = 20 * 60 * 1000;

type Spot = { flag: string; message: string; i?: number; line?: number; t0: number | null };
type Timed = {
  words_json: { words: unknown[]; lines: unknown[]; gaps: unknown[] };
  check: { by: "expect" | "conf"; within: number; of: number; share: number; ok: boolean; gate?: number };
  failures: string[];
  flags: Spot[];
  ear_check: Spot[];
  sources: { w2v: number; whisper: number; interp: number };
  whisper_ran: boolean;
  lines: number;
  duration: number;
  models: Record<string, string>;
};

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    vocals: { type: "string" },
    lyrics: { type: "string" },
    out: { type: "string" },
    display: { type: "string" },
    expect: { type: "string" },
    "min-conf": { type: "string" },
  });
  if (!values.vocals || !values.lyrics || !values.out) {
    throw new Refused([`${COMMAND}: --vocals <path>, --lyrics <path> and --out <dir> are required`]);
  }
  const vocals = requireFile(fromCaller(values.vocals), "--vocals");
  const lyrics = requireFile(fromCaller(values.lyrics), "--lyrics");
  const display = values.display ? requireFile(fromCaller(values.display), "--display") : null;
  const expect = values.expect ? requireFile(fromCaller(values.expect), "--expect") : null;
  let minConf = 0.5;
  if (values["min-conf"] !== undefined) {
    minConf = /^\d+(\.\d+)?$/.test(values["min-conf"]) ? Number(values["min-conf"]) : NaN;
    if (!(minConf >= 0 && minConf <= 1)) throw new Refused(["--min-conf wants a number from 0 to 1"]);
  }
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const spec = { vocals, lyrics, display, expect, min_conf: minConf };
  const timed = await python<Timed>("words", [JSON.stringify(spec)], TIMEOUT_MS);
  writeIn(out, "words.json", JSON.stringify(timed.words_json, null, 2) + "\n");
  writeReport(out, "words", {
    ok: timed.check.ok,
    inputs: { vocals, lyrics, display, expect, min_conf: minConf },
    outputs: { words: "words.json", report: "words-report.json" },
    check: timed.check,
    sources: timed.sources,
    whisper_ran: timed.whisper_ran,
    ear_check: timed.ear_check,
    flags: timed.flags,
    models: timed.models,
    duration: timed.duration,
  });
  // The lines quote words from the sheet: printed with every control escaped.
  if (!timed.check.ok) throw new Failed(timed.failures.map((line) => printable(line)));

  const { w2v, whisper, interp } = timed.sources;
  const checked =
    timed.check.by === "expect"
      ? `${timed.check.within} of ${timed.check.of} within 0.10 s of the expected times`
      : `${timed.check.within} of ${timed.check.of} with confidence ${timed.check.gate} or more`;
  console.log(`words: ${timed.check.of} words in ${timed.lines} lines (${w2v} w2v, ${whisper} whisper, ${interp} interp), ${checked}`);
  for (const spot of timed.ear_check) console.log(`ear check: ${printable(spot.message)}`);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
