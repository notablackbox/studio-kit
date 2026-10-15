import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { KEY, readBoard, type Shot } from "./lib/board.ts";

// film:edl: the edit list (claudia.gallery's toolkit wiki, item 17; edl.json in wiki/formats).
// Every shot resolves to its sources, keyed by shot id:
// - a sung or motion shot plays its clip's delivered take (the latest `n`) from its start, at
//   clip time `in = t0 - song_t0 + lag_s` (lag 0 when the take has no sync). A sung take whose
//   shot runs past its in-sync spans is cut at the take's `cut_at` to its first cover, which
//   plays from there by its own song_t0 and lag, and so on down the chain;
// - a hole (a clip or cover with no delivered take, or a sung take that diverges with no cover)
//   is filled from the shot's plate, with a note in the report;
// - a still or 2.5D shot is its plate.
// A shot with neither a take nor a plate fails (exit 3). The report also gives, per sung shot,
// how much of its sung time (from --words) the in-sync spans cover.

const COMMAND = "film:edl";
const EPS = 1e-6;
const WORD_PAD = 0.03; // a sung stretch is each word +/- 30 ms ...
const WORD_MERGE = 0.12; // ... merged when closer than this
const SPAN_LEAD = 0.06; // an in-sync span's start, extended back

type Sync = { lag_s: number; synced: [number, number][]; cut_at: number | null };
type Take = { n: number; status: string; sync: Sync | null };
type Clip = { id: string; song_t0: number; takes: Take[]; covers: string[] };
type Seg = { t0: number; clip: string; in: number } | { t0: number; plate: string };
type Entry = { segs: Seg[] } | { plate: string };
type Fallback = { shot: string; clip: string; at: number; fallback: "no take" | "no cover"; plate: string };

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isClipShot = (s: Shot) => s.motion_tier === "sung" || s.motion_tier === "motion";

function parseClip(raw: unknown): Clip | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !isNumber(raw.song_t0) || !Array.isArray(raw.takes)) return null;
  const takes: Take[] = [];
  for (const t of raw.takes) {
    if (!isObject(t) || !Number.isInteger(t.n) || typeof t.status !== "string") return null;
    let sync: Sync | null = null;
    if (t.sync != null) {
      const s = t.sync;
      if (!isObject(s)) return null;
      const synced = s.synced ?? [];
      if (!Array.isArray(synced) || !synced.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber))) return null;
      if (s.lag_s != null && !isNumber(s.lag_s)) return null;
      if (s.cut_at != null && !isNumber(s.cut_at)) return null;
      sync = { lag_s: (s.lag_s as number | undefined) ?? 0, synced: synced as [number, number][], cut_at: (s.cut_at as number | null | undefined) ?? null };
    }
    takes.push({ n: t.n as number, status: t.status, sync });
  }
  const covers = raw.covers ?? [];
  if (!Array.isArray(covers) || !covers.every((c) => typeof c === "string" && KEY.test(c))) return null;
  return { id: raw.id, song_t0: raw.song_t0, takes, covers: covers as string[] };
}

// The clips the board needs, its covers followed, read before any work; absent files are null.
function readClips(folder: string, roots: string[]): Map<string, Clip | null> {
  const clips = new Map<string, Clip | null>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (clips.has(id)) continue;
    const file = join(folder, `${id}.json`);
    let text: string | null = null;
    try {
      if (statSync(file).isFile()) text = readFileSync(file, "utf8");
    } catch {
      text = null;
    }
    if (text === null) {
      clips.set(id, null);
      continue;
    }
    let clip: Clip | null = null;
    try {
      clip = parseClip(JSON.parse(text));
    } catch {
      clip = null;
    }
    if (!clip) throw new Refused([`--clips: ${shown(`${id}.json`)} is not a clip file`]);
    if (clip.id !== id) throw new Refused([`--clips: ${shown(`${id}.json`)} holds clip ${shown(clip.id)}`]);
    clips.set(id, clip);
    queue.push(...clip.covers);
  }
  return clips;
}

const delivered = (clip: Clip | null): Take | null =>
  clip ? clip.takes.filter((t) => t.status === "delivered").sort((a, b) => b.n - a.n)[0] ?? null : null;

type Resolved = { entry: Entry | null; fallbacks: Fallback[]; why: string | null; spans: [number, number][] };

function resolve(shot: Shot, clips: Map<string, Clip | null>): Resolved {
  const fallbacks: Fallback[] = [];
  if (!isClipShot(shot) || !shot.clip) {
    return shot.plate ? { entry: { plate: shot.plate }, fallbacks, why: null, spans: [] } : { entry: null, fallbacks, why: null, spans: [] };
  }
  const segs: Seg[] = [];
  const spans: [number, number][] = [];
  let t = shot.t0;
  let id = shot.clip;
  for (let guard = 0; guard < 16; guard++) {
    const clip = clips.get(id) ?? null;
    const take = delivered(clip);
    if (!take || !clip) {
      if (!shot.plate) return { entry: null, fallbacks, why: `clip ${shown(id)} has no delivered take`, spans };
      fallbacks.push({ shot: shot.id, clip: id, at: r4(t), fallback: "no take", plate: shot.plate });
      if (segs.length === 0) return { entry: { plate: shot.plate }, fallbacks, why: null, spans };
      segs.push({ t0: r4(t), plate: shot.plate });
      break;
    }
    const lag = take.sync?.lag_s ?? 0;
    segs.push({ t0: r4(t), clip: `${clip.id}-t${take.n}`, in: r4(t - clip.song_t0 + lag) });
    // A sung take is cut where it diverges, when the shot runs past its in-sync spans.
    const sync = take.sync;
    const syncedEnd = sync && sync.synced.length > 0 ? Math.max(...sync.synced.map((s) => s[1])) : null;
    const cut = shot.motion_tier === "sung" && sync && sync.cut_at !== null && syncedEnd !== null && shot.t1 > syncedEnd + EPS ? sync.cut_at : null;
    const end = cut !== null && cut > t + EPS && cut < shot.t1 - EPS ? cut : shot.t1;
    if (sync) for (const [a, b] of sync.synced) spans.push([Math.max(a - SPAN_LEAD, t), Math.min(b, end)]);
    if (end >= shot.t1 - EPS) break;
    if (clip.covers.length === 0) {
      if (!shot.plate) return { entry: null, fallbacks, why: `clip ${shown(clip.id)} diverges at ${end.toFixed(3)} s and has no cover`, spans };
      fallbacks.push({ shot: shot.id, clip: clip.id, at: r4(end), fallback: "no cover", plate: shot.plate });
      segs.push({ t0: r4(end), plate: shot.plate });
      break;
    }
    t = end;
    id = clip.covers[0];
  }
  return { entry: { segs }, fallbacks, why: null, spans };
}

// Sung seconds in the shot (words +/- 30 ms, merged under 0.12 s) and those inside in-sync spans.
function coverage(shot: Shot, words: { t0: number; t1: number }[], spans: [number, number][]) {
  const stretches: [number, number][] = [];
  for (const w of words.filter((w) => w.t0 >= shot.t0 - EPS && w.t0 < shot.t1 - EPS).sort((a, b) => a.t0 - b.t0)) {
    const a = Math.max(shot.t0, w.t0 - WORD_PAD);
    const b = Math.min(shot.t1, w.t1 + WORD_PAD);
    const last = stretches[stretches.length - 1];
    if (last && a - last[1] < WORD_MERGE) last[1] = Math.max(last[1], b);
    else stretches.push([a, b]);
  }
  const sung = stretches.reduce((s, [a, b]) => s + (b - a), 0);
  let synced = 0;
  for (const [a, b] of stretches) {
    // The spans may overlap each other: walk the stretch through their union.
    const cuts = spans.map(([x, y]) => [Math.max(a, x), Math.min(b, y)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
    let covered = a;
    for (const [x, y] of cuts) {
      if (y <= covered) continue;
      synced += y - Math.max(x, covered);
      covered = y;
    }
  }
  return { sung_s: r4(sung), synced_s: r4(synced), share: sung > 0 ? r4(synced / sung) : null };
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    board: { type: "string" },
    clips: { type: "string" },
    words: { type: "string" },
    out: { type: "string" },
  });
  if (!values.board || !values.clips || !values.words || !values.out) {
    throw new Refused([`${COMMAND}: --board, --clips, --words and --out are required`]);
  }
  const boardFile = requireFile(fromCaller(values.board), "--board");
  const clipsDir = fromCaller(values.clips);
  let folder = false;
  try {
    folder = statSync(clipsDir).isDirectory();
  } catch {
    folder = false;
  }
  if (!folder) throw new Refused(["--clips is not a folder"]);
  const wordsFile = requireFile(fromCaller(values.words), "--words");
  const { board } = readBoard(boardFile);
  let words: { t0: number; t1: number }[];
  try {
    const raw = JSON.parse(readFileSync(wordsFile, "utf8"));
    if (!isObject(raw) || !Array.isArray(raw.words) || !raw.words.every((w) => isObject(w) && isNumber(w.t0) && isNumber(w.t1))) throw new Error("shape");
    words = raw.words as { t0: number; t1: number }[];
  } catch {
    throw new Refused(["--words is not a words.json"]);
  }
  const clips = readClips(clipsDir, [...new Set(board.shots.filter((s) => isClipShot(s) && s.clip).map((s) => s.clip as string))]);
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const edl: Record<string, Entry> = {};
  const fallbacks: Fallback[] = [];
  const missing: { shot: string; why: string | null }[] = [];
  const cover: Record<string, ReturnType<typeof coverage>> = {};
  for (const shot of board.shots) {
    const resolved = resolve(shot, clips);
    fallbacks.push(...resolved.fallbacks);
    if (resolved.entry) edl[shot.id] = resolved.entry;
    else missing.push({ shot: shot.id, why: resolved.why });
    if (shot.motion_tier === "sung") cover[shot.id] = coverage(shot, words, resolved.spans);
  }
  const inputs = { board: boardFile, clips: clipsDir, words: wordsFile };
  if (missing.length > 0) {
    writeReport(out, "edl", { ok: false, inputs, outputs: { report: "edl-report.json" }, shots: board.shots.length, fallbacks, missing: missing.map((m) => m.shot), coverage: cover });
    throw new Failed(missing.map((m) => `edl: ${shown(m.shot)} has neither a take nor a plate${m.why ? ` (${m.why})` : ""}`));
  }
  writeIn(out, "edl.json", JSON.stringify(edl, null, 2) + "\n");
  writeReport(out, "edl", { ok: true, inputs, outputs: { edl: "edl.json", report: "edl-report.json" }, shots: board.shots.length, fallbacks, missing: [], coverage: cover });

  const entries = Object.values(edl);
  const fromTakes = entries.filter((e): e is { segs: Seg[] } => "segs" in e);
  const segments = fromTakes.reduce((n, e) => n + e.segs.length, 0);
  console.log(
    `edl: ${board.shots.length} shots, ${fromTakes.length} from takes (${segments} segments), ${entries.length - fromTakes.length} from plates, ${fallbacks.length} fallback${fallbacks.length === 1 ? "" : "s"}`,
  );
  for (const f of fallbacks) {
    const why = f.fallback === "no take" ? "has no delivered take" : "diverges and has no cover";
    console.log(`fallback: ${shown(f.shot)} plays plate ${shown(f.plate)} from ${f.at.toFixed(3)} s: clip ${shown(f.clip)} ${why}`);
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
