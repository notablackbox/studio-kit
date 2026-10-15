import { readFileSync } from "node:fs";
import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeReport } from "./lib/cli.ts";
import { FILM_FPS, lyricLines, parseTokens } from "../remotion/film/plan.ts";

// film:gate: the lyric gate (toolkit item 19; R1). Every sung word in the span the tokens
// sidecar covers must be drawn on the frame holding its start (within one frame either side):
// the sidecar, written by film:chapter from the same frameState the pixels come from, must list
// the word's index on one of those frames. Prints `gate: N/N`; exit 3 with one line per word
// that was not drawn (the report written). The display text decides what is sung on screen:
// each display line must consume exactly its line's words, or the gate refuses (exit 2).

const COMMAND = "film:gate";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readJson(path: string, flag: string): unknown {
  try {
    return JSON.parse(readFileSync(requireFile(path, flag), "utf8"));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused([`${flag} is not JSON`]);
  }
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { tokens: { type: "string" }, words: { type: "string" }, display: { type: "string" }, out: { type: "string" } });
  if (!values.tokens || !values.words || !values.display || !values.out) throw new Refused([`${COMMAND}: --tokens, --words, --display and --out are required`]);
  const tokensFile = fromCaller(values.tokens);
  const wordsFile = fromCaller(values.words);
  const displayFile = fromCaller(values.display);
  const sidecar = readJson(tokensFile, "--tokens");
  const ok =
    isObj(sidecar) &&
    sidecar.fps === FILM_FPS &&
    Array.isArray(sidecar.frames) &&
    sidecar.frames.length > 0 &&
    sidecar.frames.every((f) => isObj(f) && isNum(f.t) && Array.isArray(f.tokens) && f.tokens.every((t) => isObj(t) && Number.isInteger(t.word)));
  if (!ok) throw new Refused(["--tokens is not a tokens sidecar ({fps: 24, frames: [{t, tokens: [{word, text}]}]})"]);
  const raw = readJson(wordsFile, "--words");
  if (!isObj(raw) || !Array.isArray(raw.words) || !raw.words.every((w) => isObj(w) && isNum(w.t0) && Number.isInteger(w.line))) throw new Refused(["--words is not a words.json"]);
  const words = (raw.words as Obj[]).map((w, k) => ({ i: Number.isInteger(w.i) ? (w.i as number) : k, w: String(w.w ?? ""), line: w.line as number, t0: w.t0 as number }));
  const display = lyricLines(readFileSync(requireFile(displayFile, "--display"), "utf8"));
  const problems: string[] = [];
  const lines = [...new Set(words.map((w) => w.line))].sort((a, b) => a - b);
  if (display.length !== lines.length) problems.push(`--display has ${display.length} lyric line${display.length === 1 ? "" : "s"}, words.json has ${lines.length}`);
  else
    display.forEach((text, n) => {
      const want = words.filter((w) => w.line === n).length;
      const got = parseTokens(text).reduce((s, t) => s + t.count, 0);
      if (got !== want) problems.push(`--display line ${n} (${shown(text)}) shows ${got} sung words, words.json has ${want}`);
    });
  const out = fromCaller(values.out);
  const issue = outProblem(out);
  if (issue) problems.push(issue);
  if (problems.length > 0) throw new Refused(problems);

  // Frames on the song clock: frame F shows song time F / 24.
  const frames = new Map<number, Set<number>>();
  for (const f of (sidecar as { frames: { t: number; tokens: { word: number }[] }[] }).frames) {
    frames.set(Math.round(f.t * FILM_FPS), new Set(f.tokens.map((t) => t.word)));
  }
  const first = Math.min(...frames.keys());
  const last = Math.max(...frames.keys());
  const inSpan = words.filter((w) => {
    const f = Math.floor(w.t0 * FILM_FPS + 1e-6);
    return f >= first && f <= last;
  });
  const missing: { i: number; w: string; t0: number; frame: number }[] = [];
  for (const w of inSpan) {
    const f = Math.floor(w.t0 * FILM_FPS + 1e-6);
    const drawn = [f - 1, f, f + 1].some((k) => frames.get(k)?.has(w.i));
    if (!drawn) missing.push({ i: w.i, w: w.w, t0: w.t0, frame: f });
  }
  const drawn = inSpan.length - missing.length;
  const report = {
    ok: missing.length === 0,
    inputs: { tokens: tokensFile, words: wordsFile, display: displayFile },
    outputs: { report: "gate-report.json" },
    span: { first, last, t0: first / FILM_FPS, t1: (last + 1) / FILM_FPS },
    drawn,
    total: inSpan.length,
    missing,
  };
  writeReport(out, "gate", report);
  if (missing.length > 0) {
    throw new Failed([`gate: ${drawn}/${inSpan.length}`, ...missing.map((m) => `gate: word ${m.i} ${shown(m.w)} at ${m.t0.toFixed(3)} s (frame ${m.frame}) is not drawn`)]);
  }
  console.log(`gate: ${drawn}/${inSpan.length}`);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
