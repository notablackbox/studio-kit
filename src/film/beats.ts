import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, python, requireFile, run, writeIn, writeReport } from "./lib/cli.ts";

// film:beats: the beat map of a take, from its drum stem. Never one BPM: local tempos on 20 s
// windows every 5 s (0.05 BPM and 4 ms phase steps), beats stepped along the tempo curve and
// snapped to drum onsets within 30 ms, downbeats by a kick vote unless --downbeat-phase sets
// them, sections from the lyric sheet's tags (lyrics-tag when timed by the words, else
// heuristic; an empty or coinciding tag merged with a note). Writes beats.json (the formats
// wiki's shape). A silent drum stem (its onset strength peaks under the floor) fails, exit 3:
// the report is written and no beats.json, since any grid on silence would be arbitrary.

const COMMAND = "film:beats";
const TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RANGE: [number, number] = [70, 180];

type BeatMap = {
  duration: number;
  beats: number[];
  downbeats: number[];
  tempo: { t: number; bpm: number }[];
  downbeat_phase: number;
  downbeat_method: "kick" | "manual";
  sections: unknown[];
};
type Mapped =
  | { silent?: undefined; beats_json: BeatMap; kick_votes: number[] | null; section_notes: string[]; windows: unknown[]; sample_rate: number }
  | { silent: true; onset_peak: number; onset_floor: number; duration: number };

function tempoRange(text: string | undefined): [number, number] {
  if (text === undefined) return DEFAULT_RANGE;
  const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(text);
  const [low, high] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(low >= 40 && high <= 300 && low < high)) throw new Refused(["--tempo-range wants low,high in BPM, between 40 and 300"]);
  return [low, high];
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    drums: { type: "string" },
    out: { type: "string" },
    "downbeat-phase": { type: "string" },
    lyrics: { type: "string" },
    words: { type: "string" },
    "tempo-range": { type: "string" },
  });
  if (!values.drums || !values.out) throw new Refused([`${COMMAND}: --drums <path> and --out <dir> are required`]);
  const drums = requireFile(fromCaller(values.drums), "--drums");
  const out = fromCaller(values.out);
  let phase: number | null = null;
  if (values["downbeat-phase"] !== undefined) {
    if (!/^[0-3]$/.test(values["downbeat-phase"])) throw new Refused(["--downbeat-phase wants 0, 1, 2 or 3"]);
    phase = Number(values["downbeat-phase"]);
  }
  const range = tempoRange(values["tempo-range"]);
  const lyrics = values.lyrics ? requireFile(fromCaller(values.lyrics), "--lyrics") : null;
  if (values.words && !lyrics) throw new Refused(["--words needs --lyrics"]);
  const words = values.words ? requireFile(fromCaller(values.words), "--words") : null;
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const spec = { drums, downbeat_phase: phase, tempo_range: range, lyrics, words };
  const mapped = await python<Mapped>("beats", [JSON.stringify(spec)], TIMEOUT_MS);
  const inputs = { drums, lyrics, words, downbeat_phase: phase, tempo_range: range };
  if (mapped.silent) {
    writeReport(out, "beats", {
      ok: false,
      inputs,
      outputs: { report: "beats-report.json" },
      duration: mapped.duration,
      onset_peak: mapped.onset_peak,
      onset_floor: mapped.onset_floor,
    });
    throw new Failed(["beats: the drum stem is silent (no onsets)"]);
  }
  const map = mapped.beats_json;
  writeIn(out, "beats.json", JSON.stringify(map, null, 2) + "\n");
  const bpms = map.tempo.map((t) => t.bpm);
  writeReport(out, "beats", {
    ok: true,
    inputs,
    outputs: { beats: "beats.json", report: "beats-report.json" },
    beats: map.beats.length,
    bars: map.downbeats.length,
    bpm: { first: bpms[0], last: bpms.at(-1), min: Math.min(...bpms), max: Math.max(...bpms) },
    downbeat_method: map.downbeat_method,
    downbeat_phase: map.downbeat_phase,
    kick_votes: mapped.kick_votes,
    windows: mapped.windows,
    sections: map.sections.length,
    section_notes: mapped.section_notes,
  });
  console.log(
    `beats: ${map.beats.length} beats, ${map.downbeats.length} bars, ${bpms[0].toFixed(2)} to ${bpms.at(-1)!.toFixed(2)} BPM, downbeats by ${map.downbeat_method} (phase ${map.downbeat_phase})`,
  );
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
