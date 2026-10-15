import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { EXIT, Failed, Refused, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeReport } from "./lib/cli.ts";
import { lyricLines, readBoard, type Board, type Shot } from "./lib/board.ts";

// film:audit: the board's gates (claudia.gallery's storyboard wiki, "The audit", and the kit's
// v0.2.0 additions), each with its result and the shots that fail it:
//   tile        the shots tile the song: no gap, no overlap, from 0 to the song's end;
//   cuts        every cut within 0.03 s of a beat, a hit in hits.json, or the hit its shot declares;
//   sections    every shot's section is a section of the beat map;
//   words       every word starts in a shot that lists its line and types it;
//   graphics    every lyric line has an explaining graphic (a device naming the line);
//   lead        her share of the screen at or above --lead-share (default 0.7);
//   budget      planned clip seconds and clips within --motion-seconds and --motion-clips;
//   windows     sung shots run 4 to 8 s and start in a word gap; motion shots run 4 to 12 s;
//   plates      a plate on two shots only when they are one continuous moment; two clips
//               never start from one plate;
//   banned      no --taboo word (whole words, any case) in any string of the board;
//   treatments  every 2.5D shot has a treatment, never the same on two 2.5D shots in a row;
//   todo        no TODO or TBD (any case) or ??? anywhere; every shot has a framing and a
//               tier; a clip shot names its clip and a 2.5D shot its plate;
//   genuine     a genuine shot names its clip or footage, and it is recorded in
//               walk-report.json or recordings.json (only that is deferred with --defer
//               provenance);
//   hook        every --hooks entry is a masthead or mass card at least once (or, written in
//               " / " parts, a stack of its parts);
//   box         two chapters in a row are never in the same box.
// Exit 3 with one line per failing gate; the report lists every gate.

const COMMAND = "film:audit";
const CUT_TOLERANCE = 0.03;
const EPS = 1e-6;
const TILE_EPS = 0.001;
const SUNG = [4, 8];
const MOTION = [4, 12];
const LEAD_WARN = 0.85;
// Any case, as whole words (so "mastodon" is not a placeholder); "???" anywhere.
const PLACEHOLDER = /(?<![\p{L}\p{N}])(?:todo|tbd)(?![\p{L}\p{N}])|\?\?\?/iu;
const GATES = ["tile", "cuts", "sections", "words", "graphics", "lead", "budget", "windows", "plates", "banned", "treatments", "todo", "genuine", "hook", "box"] as const;

type GateName = (typeof GATES)[number];
type Status = "pass" | "fail" | "deferred" | "skipped";
type Gate = { gate: GateName; status: Status; shots: string[]; problems: string[]; [key: string]: unknown };
type Word = { i: number; w: string; line: number; t0: number; t1: number };
type Analysis = {
  beats: number[];
  sections: string[];
  duration: number;
  words: Word[];
  gaps: { t0: number; t1: number }[];
  lineCount: number;
  hits: number[];
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const num = (x: number) => String(r3(x));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const q = (id: string) => shown(id);
const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
// A hook or a card's text compared: any case, punctuation dropped, spaces folded.
const bare = (text: string) => norm(text.replace(/[^\p{L}\p{N}\s]/gu, " "));
const isClipShot = (s: Shot) => s.motion_tier === "sung" || s.motion_tier === "motion";

function readJson(file: string, flag: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(requireFile(file, flag), "utf8"));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused([`${flag} is not a ${what}`]);
  }
}

function readAnalysis(paths: { beats: string; words: string; hits: string; display: string }): Analysis {
  const beats = readJson(paths.beats, "--beats", "beats.json");
  if (
    !isObject(beats) ||
    !Array.isArray(beats.beats) ||
    !beats.beats.every(isNumber) ||
    !isNumber(beats.duration) ||
    !Array.isArray(beats.sections) ||
    !beats.sections.every((s) => isObject(s) && typeof s.name === "string")
  ) {
    throw new Refused(["--beats is not a beats.json"]);
  }
  const words = readJson(paths.words, "--words", "words.json");
  if (
    !isObject(words) ||
    !Array.isArray(words.words) ||
    !words.words.every((w) => isObject(w) && isNumber(w.t0) && isNumber(w.t1) && Number.isInteger(w.line))
  ) {
    throw new Refused(["--words is not a words.json"]);
  }
  const hits = readJson(paths.hits, "--hits", "hits.json");
  if (!isObject(hits) || !Array.isArray(hits.hits) || !hits.hits.every((h) => isObject(h) && isNumber(h.t))) {
    throw new Refused(["--hits is not a hits.json"]);
  }
  let display: string[];
  try {
    display = lyricLines(readFileSync(requireFile(paths.display, "--display"), "utf8"));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(["--display cannot be read"]);
  }
  const wordList = (words.words as Record<string, unknown>[]).map((w, n) => ({
    i: Number.isInteger(w.i) ? (w.i as number) : n,
    w: String(w.w ?? ""),
    line: w.line as number,
    t0: w.t0 as number,
    t1: w.t1 as number,
  }));
  const lineCount = Array.isArray(words.lines) ? words.lines.length : new Set(wordList.map((w) => w.line)).size;
  if (display.length !== lineCount) {
    throw new Refused([`--display has ${display.length} lyric line${display.length === 1 ? "" : "s"}, words.json has ${lineCount}`]);
  }
  const gaps = Array.isArray(words.gaps) ? (words.gaps as unknown[]).filter((g): g is { t0: number; t1: number } => isObject(g) && isNumber(g.t0) && isNumber(g.t1)) : [];
  return {
    beats: beats.beats as number[],
    sections: [...new Set((beats.sections as { name: string }[]).map((s) => s.name))],
    duration: beats.duration as number,
    words: wordList,
    gaps,
    lineCount,
    hits: (hits.hits as { t: number }[]).map((h) => h.t),
  };
}

// The files a genuine shot may name: the walk's recorded shots, and recordings.json's entries.
function readProvenance(walkReport: string | null, recordings: string | null): Set<string> | null {
  if (!walkReport && !recordings) return null;
  const files = new Set<string>();
  if (walkReport) {
    const raw = readJson(walkReport, "--walk-report", "walk-report.json");
    if (!isObject(raw) || !Array.isArray(raw.shots) || !raw.shots.every((s) => isObject(s) && typeof s.file === "string" && typeof s.status === "string")) {
      throw new Refused(["--walk-report is not a walk-report.json"]);
    }
    for (const s of raw.shots as { file: string; status: string }[]) if (s.status === "recorded" && s.file !== "") files.add(s.file);
  }
  if (recordings) {
    const raw = readJson(recordings, "--recordings", "recordings.json");
    if (!isObject(raw) || !Array.isArray(raw.recordings) || !raw.recordings.every((s) => isObject(s) && typeof s.file === "string")) {
      throw new Refused(["--recordings is not a recordings.json"]);
    }
    for (const s of raw.recordings as { file: string }[]) if (s.file !== "") files.add(s.file);
  }
  return files;
}

type Options = {
  leadShare: number;
  motionSeconds: number | null;
  motionClips: number | null;
  taboo: string[];
  hooks: string[];
  deferProvenance: boolean;
  provenance: Set<string> | null;
};

export function auditBoard(board: Board, analysis: Analysis, options: Options): { gates: Gate[]; warnings: string[]; summary: Record<string, number> } {
  const shots = board.shots;
  const song = analysis.duration;
  const gates: Gate[] = [];
  const add = (gate: GateName, problems: string[], shotIds: Iterable<string>, extra: Record<string, unknown> = {}, status?: Status) => {
    const ids = [...new Set(shotIds)].sort();
    gates.push({ gate, status: status ?? (problems.length > 0 ? "fail" : "pass"), shots: ids, problems, ...extra });
  };

  // tile
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const first = shots[0];
    const last = shots[shots.length - 1];
    if (Math.abs(first.t0) > TILE_EPS) {
      problems.push(`the first shot ${q(first.id)} starts at ${num(first.t0)} s, not 0`);
      ids.push(first.id);
    }
    for (let k = 1; k < shots.length; k++) {
      const a = shots[k - 1];
      const b = shots[k];
      if (a.t1 > b.t0 + TILE_EPS) {
        problems.push(`${q(a.id)} ends at ${num(a.t1)} s, after ${q(b.id)} starts at ${num(b.t0)} s`);
        ids.push(a.id, b.id);
      } else if (b.t0 > a.t1 + TILE_EPS) {
        problems.push(`a gap from ${num(a.t1)} to ${num(b.t0)} s after ${q(a.id)}`);
        ids.push(a.id, b.id);
      }
    }
    if (Math.abs(last.t1 - song) > TILE_EPS) {
      problems.push(`the last shot ${q(last.id)} ends at ${num(last.t1)} s, the song at ${num(song)} s`);
      ids.push(last.id);
    }
    if (Math.abs(board.duration - song) > TILE_EPS) problems.push(`the board's duration is ${num(board.duration)} s, the song's ${num(song)} s`);
    add("tile", problems, ids);
  }

  // cuts: every shot start but the first, and every end not met by the next start.
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const nearest = (t: number, list: number[]) => list.reduce((best, x) => Math.min(best, Math.abs(x - t)), Infinity);
    const check = (t: number, shot: Shot, into: boolean) => {
      if (nearest(t, analysis.beats) <= CUT_TOLERANCE + EPS) return;
      if (nearest(t, analysis.hits) <= CUT_TOLERANCE + EPS) return;
      if (into && shot.hit !== undefined && Math.abs(shot.hit - t) <= CUT_TOLERANCE + EPS) return;
      problems.push(`the cut at ${t.toFixed(3)} s ${into ? "into" : "out of"} ${q(shot.id)} is ${nearest(t, analysis.beats).toFixed(3)} s from the nearest beat`);
      ids.push(shot.id);
    };
    shots.forEach((shot, k) => {
      if (k > 0) check(shot.t0, shot, true);
      if (k < shots.length - 1 && Math.abs(shots[k + 1].t0 - shot.t1) > TILE_EPS) check(shot.t1, shot, false);
    });
    add("cuts", problems, ids);
  }

  // sections
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const known = analysis.sections.map((s) => shown(s)).join(", ");
    for (const shot of shots) {
      if (shot.section === undefined) {
        problems.push(`${q(shot.id)} has no section`);
        ids.push(shot.id);
      } else if (!analysis.sections.includes(shot.section)) {
        problems.push(`${q(shot.id)} is in ${shown(shot.section)}, not a section of the beat map (${known})`);
        ids.push(shot.id);
      }
    }
    add("sections", problems, ids);
  }

  // words: a word belongs to the shot its start falls in.
  {
    const problems: string[] = [];
    const ids: string[] = [];
    for (const shot of shots) {
      const inside = analysis.words.filter((w) => w.t0 >= shot.t0 - EPS && w.t0 < shot.t1 - EPS);
      const byLine = new Map<number, Word[]>();
      for (const w of inside) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
      for (const [line, words] of [...byLine].sort((a, b) => a[0] - b[0])) {
        const span = words.length === 1 ? `word ${words[0].i}` : `words ${words[0].i} to ${words[words.length - 1].i}`;
        if (!shot.lines.includes(line)) {
          problems.push(`${q(shot.id)} has ${span} of line ${line} and does not list the line`);
          ids.push(shot.id);
        } else if (!shot.type.some((t) => t.line === line && t.text.trim() !== "")) {
          problems.push(`${q(shot.id)} has ${span} of line ${line} and types no text for it`);
          ids.push(shot.id);
        }
      }
    }
    add("words", problems, ids);
  }

  // graphics: every lyric line (display.txt's, and any a shot lists) has a device naming it.
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const lines = new Set<number>(Array.from({ length: analysis.lineCount }, (_, k) => k));
    for (const shot of shots) for (const line of shot.lines) lines.add(line);
    const explained = new Set(shots.flatMap((s) => s.devices.map((d) => d.line)));
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (!explained.has(line)) {
        problems.push(`line ${line} has no explaining graphic`);
        ids.push(...shots.filter((s) => s.lines.includes(line)).map((s) => s.id));
      }
    }
    add("graphics", problems, ids);
  }

  // lead
  const leadSeconds = shots.filter((s) => s.lead_on_screen).reduce((sum, s) => sum + (s.t1 - s.t0), 0);
  const share = song > 0 ? leadSeconds / song : 0;
  {
    const problems = share + EPS < options.leadShare ? [`she is on screen ${(share * 100).toFixed(1)}% of the song, want at least ${(options.leadShare * 100).toFixed(1)}%`] : [];
    add("lead", problems, [], { share: Math.round(share * 10000) / 10000, target: options.leadShare });
  }

  // budget
  const clipShots = shots.filter(isClipShot);
  const clipSeconds = clipShots.reduce((sum, s) => sum + (s.t1 - s.t0), 0);
  const clipCount = new Set(clipShots.map((s) => s.clip ?? s.id)).size;
  {
    const problems: string[] = [];
    if (options.motionSeconds !== null && clipSeconds > options.motionSeconds + EPS) problems.push(`the clips run ${clipSeconds.toFixed(2)} s, the budget is ${num(options.motionSeconds)} s`);
    if (options.motionClips !== null && clipCount > options.motionClips) problems.push(`${clipCount} clips, the budget is ${options.motionClips}`);
    const skipped = options.motionSeconds === null && options.motionClips === null;
    add("budget", problems, problems.length > 0 ? clipShots.map((s) => s.id) : [], { clip_seconds: r3(clipSeconds), clips: clipCount, seconds_budget: options.motionSeconds, clips_budget: options.motionClips }, skipped ? "skipped" : undefined);
  }

  // windows
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const insideWord = (t: number) => {
      if (analysis.gaps.some((g) => t >= g.t0 - EPS && t <= g.t1 + EPS)) return null;
      return analysis.words.find((w) => t >= w.t0 - EPS && t < w.t1 - EPS) ?? null;
    };
    for (const shot of shots) {
      const length = shot.t1 - shot.t0;
      if (shot.motion_tier === "sung") {
        if (length < SUNG[0] - EPS || length > SUNG[1] + EPS) {
          problems.push(`sung ${q(shot.id)} runs ${length.toFixed(3)} s, want ${SUNG[0]} to ${SUNG[1]} s`);
          ids.push(shot.id);
        }
        const word = insideWord(shot.t0);
        if (word) {
          problems.push(`sung ${q(shot.id)} starts at ${shot.t0.toFixed(3)} s inside word ${word.i} ${shown(word.w)}, not in a word gap`);
          ids.push(shot.id);
        }
      } else if (shot.motion_tier === "motion" && (length < MOTION[0] - EPS || length > MOTION[1] + EPS)) {
        problems.push(`motion ${q(shot.id)} runs ${length.toFixed(3)} s, want ${MOTION[0]} to ${MOTION[1]} s`);
        ids.push(shot.id);
      }
    }
    add("windows", problems, ids);
  }

  // plates
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const byPlate = new Map<string, number[]>();
    shots.forEach((s, k) => {
      if (s.plate) byPlate.set(s.plate, [...(byPlate.get(s.plate) ?? []), k]);
    });
    for (const [plate, at] of byPlate) {
      for (let n = 1; n < at.length; n++) {
        if (at[n] !== at[n - 1] + 1) {
          const [a, b] = [shots[at[n - 1]], shots[at[n]]];
          problems.push(`plate ${shown(plate)} is on ${q(a.id)} and ${q(b.id)}, which are not one continuous moment`);
          ids.push(a.id, b.id);
        }
      }
      const clips = [...new Set(at.map((k) => shots[k]).filter((s) => isClipShot(s) && s.clip).map((s) => s.clip as string))];
      if (clips.length > 1) {
        problems.push(`clips ${clips.map((c) => shown(c)).join(" and ")} start from one plate ${shown(plate)}`);
        ids.push(...at.map((k) => shots[k]).filter((s) => isClipShot(s) && s.clip).map((s) => s.id));
      }
    }
    add("plates", problems, ids);
  }

  // banned
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const patterns = options.taboo.map((word) => ({ word, re: new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu") }));
    // Every string in the board, reported once per word and top-level field of a shot, a
    // chapter or a plate.
    const strings = (value: unknown): string[] =>
      typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isObject(value) ? Object.values(value).flatMap(strings) : [];
    const scan = (where: string, entry: object, id: string | null) => {
      for (const [field, value] of Object.entries(entry)) {
        const texts = strings(value);
        for (const { word, re } of patterns) {
          if (texts.some((t) => re.test(t))) {
            problems.push(`${where}${id ? " " : "."}${field} has ${shown(word)}`);
            if (id) ids.push(id);
          }
        }
      }
    };
    if (patterns.length > 0) {
      for (const shot of shots) scan(q(shot.id), shot, shot.id);
      board.chapters.forEach((chapter, n) => scan(`chapters[${n}]`, chapter, null));
      board.plates.forEach((plate, n) => scan(`plates[${n}]`, plate, null));
    }
    add("banned", problems, ids, {}, undefined);
  }

  // treatments
  {
    const problems: string[] = [];
    const ids: string[] = [];
    shots.forEach((shot, k) => {
      if (shot.motion_tier !== "plate3d") return;
      if (!shot.treatment) {
        problems.push(`${q(shot.id)} is 2.5D with no treatment`);
        ids.push(shot.id);
        return;
      }
      const next = shots[k + 1];
      if (next && next.motion_tier === "plate3d" && next.treatment === shot.treatment) {
        problems.push(`${q(shot.id)} and ${q(next.id)} both use ${shown(shot.treatment)}`);
        ids.push(shot.id, next.id);
      }
    });
    add("treatments", problems, ids);
  }

  // todo
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const scan = (where: string, value: unknown, id: string | null): void => {
      if (typeof value === "string") {
        const found = value.match(PLACEHOLDER);
        if (found) {
          problems.push(`${where} has ${shown(found[0])}`);
          if (id) ids.push(id);
        }
      } else if (Array.isArray(value)) value.forEach((v, k) => scan(`${where}[${k}]`, v, id));
      else if (isObject(value)) for (const [key, v] of Object.entries(value)) scan(`${where}.${key}`, v, id);
    };
    for (const shot of shots) {
      const own = (what: string) => {
        problems.push(`${q(shot.id)} ${what}`);
        ids.push(shot.id);
      };
      if (!shot.framing) own("has no framing");
      if (!shot.motion_tier) own("has no motion tier");
      if (isClipShot(shot) && !shot.clip) own(`is ${shot.motion_tier} with no clip`);
      if (shot.motion_tier === "plate3d" && !shot.plate) own("is 2.5D with no plate");
      for (const [key, value] of Object.entries(shot)) {
        if (typeof value === "string") {
          const found = value.match(PLACEHOLDER);
          if (found) own(`${key} has ${shown(found[0])}`);
        } else scan(`${q(shot.id)} ${key}`, value, shot.id);
      }
    }
    board.chapters.forEach((c, n) => scan(`chapters[${n}]`, c, null));
    board.plates.forEach((p, n) => scan(`plates[${n}]`, p, null));
    add("todo", problems, ids);
  }

  // genuine
  {
    const problems: string[] = [];
    const ids: string[] = [];
    const deferred: string[] = [];
    const deferredIds: string[] = [];
    const genuine = shots.filter((s) => s.genuine);
    const known = options.provenance;
    // Footage matches a recorded file by name or base name; a clip id matches a file's stem.
    const stem = (file: string) => basename(file).replace(/\.[^.]*$/, "");
    const footageRecorded = (name: string) => known !== null && [...known].some((f) => f === name || basename(f) === basename(name));
    const clipRecorded = (id: string) => known !== null && [...known].some((f) => stem(f) === id);
    // Naming nothing is a board problem and fails even under --defer provenance; only "not
    // recorded (yet)" is deferred.
    for (const shot of genuine) {
      if (!shot.footage && !shot.clip) {
        problems.push(`${q(shot.id)} is genuine and names no clip or footage`);
        ids.push(shot.id);
      } else if (!(shot.footage && footageRecorded(shot.footage)) && !(shot.clip && clipRecorded(shot.clip))) {
        const what = shot.footage ? `footage ${shown(shot.footage)}` : `clip ${shown(shot.clip)}`;
        deferred.push(`${q(shot.id)} ${what} is not in walk-report.json or recordings.json${known === null ? " (none given)" : ""}`);
        deferredIds.push(shot.id);
      }
    }
    if (!options.deferProvenance) add("genuine", [...problems, ...deferred], [...ids, ...deferredIds]);
    else if (problems.length > 0) add("genuine", problems, ids, { deferred });
    else add("genuine", [], deferredIds, { deferred }, "deferred");
  }

  // hook
  {
    const problems: string[] = [];
    // A hook is full-frame when one masthead or mass card has its whole text; a hook written
    // with " / " also matches a stack card whose lines (newlines or " / ") are its parts in order.
    const cards = new Set(shots.flatMap((s) => s.type.filter((t) => t.mode === "masthead" || t.mode === "mass").map((t) => bare(t.text))));
    const stacks = new Set(
      shots.flatMap((s) => s.type.filter((t) => t.mode === "stack").map((t) => t.text.split(/\n|\s\/\s/).map(bare).filter((l) => l !== "").join("\n"))),
    );
    for (const hook of options.hooks) {
      const parts = hook.split(/\s\/\s/).map(bare).filter((l) => l !== "");
      const whole = cards.has(bare(hook));
      const stacked = parts.length > 1 && stacks.has(parts.join("\n"));
      if (!whole && !stacked) problems.push(`${shown(hook.trim())} is on no masthead or mass card${parts.length > 1 ? " and no stack of its parts" : ""}`);
    }
    add("hook", problems, []);
  }

  // box
  {
    const problems: string[] = [];
    for (let k = 1; k < board.chapters.length; k++) {
      const [a, b] = [board.chapters[k - 1], board.chapters[k]];
      if (a.box !== undefined && b.box !== undefined && norm(a.box) === norm(b.box)) {
        problems.push(`${shown(a.id)} and ${shown(b.id)} are both in the box ${shown(norm(a.box))}`);
      }
    }
    add("box", problems, []);
  }

  // Warnings: reported, never failing.
  const warnings: string[] = [];
  if (share > LEAD_WARN + EPS) warnings.push(`she is on screen ${(share * 100).toFixed(1)}% of the song, over 85%: leave room for inserts`);
  for (let k = 1; k < shots.length; k++) {
    const [a, b] = [shots[k - 1], shots[k]];
    if (a.transition_in && a.transition_in !== "cut" && a.transition_in === b.transition_in) warnings.push(`${q(a.id)} and ${q(b.id)} both come in with ${shown(a.transition_in)}`);
  }
  const used = new Set(shots.map((s) => s.plate).filter(Boolean));
  for (const plate of board.plates) if (!used.has(plate.plate)) warnings.push(`plate ${shown(plate.plate)} is used by no shot`);
  for (const shot of shots) {
    if (shot.motion_tier === "sung" && shot.prompt && /\b(microphone|mic|hand|hands|hair)\b[^.;]*\b(mouth|lips)\b/i.test(shot.prompt)) {
      warnings.push(`sung ${q(shot.id)}: the prompt may put a microphone, a hand or hair in front of her mouth`);
    }
  }

  return {
    gates,
    warnings,
    summary: { shots: shots.length, duration: r3(song), lead_share: Math.round(share * 10000) / 10000, clips: clipCount, clip_seconds: r3(clipSeconds) },
  };
}

function numberFlag(flag: string, value: string | undefined, ok: (n: number) => boolean, want: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || !ok(n)) throw new Refused([`${flag} is ${shown(value)}, want ${want}`]);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    board: { type: "string" },
    beats: { type: "string" },
    words: { type: "string" },
    hits: { type: "string" },
    display: { type: "string" },
    out: { type: "string" },
    "lead-share": { type: "string" },
    "motion-seconds": { type: "string" },
    "motion-clips": { type: "string" },
    taboo: { type: "string" },
    hooks: { type: "string" },
    defer: { type: "string" },
    "walk-report": { type: "string" },
    recordings: { type: "string" },
  });
  if (!values.board || !values.beats || !values.words || !values.hits || !values.display || !values.out) {
    throw new Refused([`${COMMAND}: --board, --beats, --words, --hits, --display and --out are required`]);
  }
  const leadShare = numberFlag("--lead-share", values["lead-share"], (n) => n >= 0 && n <= 1, "a share from 0 to 1") ?? 0.7;
  const motionSeconds = numberFlag("--motion-seconds", values["motion-seconds"], (n) => n > 0, "seconds above 0");
  const motionClips = numberFlag("--motion-clips", values["motion-clips"], (n) => Number.isInteger(n) && n >= 0, "a whole number");
  const defer = values.defer === undefined ? [] : values.defer.split(",").map((d) => d.trim());
  for (const d of defer) if (d !== "provenance") throw new Refused([`--defer is ${shown(d)}, want provenance`]);
  const split = (text: string | undefined, by: string) => (text ?? "").split(by).map((s) => s.trim()).filter((s) => s !== "");
  const taboo = split(values.taboo, ",");
  const hooks = split(values.hooks, "|");

  const paths = {
    board: requireFile(fromCaller(values.board), "--board"),
    beats: fromCaller(values.beats),
    words: fromCaller(values.words),
    hits: fromCaller(values.hits),
    display: fromCaller(values.display),
  };
  const walkReport = values["walk-report"] ? fromCaller(values["walk-report"]) : null;
  const recordings = values.recordings ? fromCaller(values.recordings) : null;
  const { board, text } = readBoard(paths.board);
  const analysis = readAnalysis(paths);
  const provenance = readProvenance(walkReport, recordings);
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);

  const result = auditBoard(board, analysis, { leadShare, motionSeconds, motionClips, taboo, hooks, deferProvenance: defer.includes("provenance"), provenance });
  const failing = result.gates.filter((g) => g.status === "fail");
  writeReport(out, "audit", {
    ok: failing.length === 0,
    inputs: { ...paths, walk_report: walkReport, recordings, lead_share: leadShare, motion_seconds: motionSeconds, motion_clips: motionClips, taboo, hooks, defer },
    outputs: { report: "audit-report.json" },
    board_sha256: createHash("sha256").update(text).digest("hex"),
    summary: result.summary,
    gates: result.gates,
    warnings: result.warnings,
  });
  if (failing.length > 0) throw new Failed(failing.map((g) => `gate ${g.gate}: ${g.problems.join("; ")}`));
  const notes = (["deferred", "skipped"] as const)
    .map((status) => [status, result.gates.filter((g) => g.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  const s = result.summary;
  console.log(
    `audit: ${GATES.length} gates, all pass${notes.length > 0 ? ` (${notes.join(", ")})` : ""}: ${s.shots} shots, ${s.duration.toFixed(2)} s, lead ${(s.lead_share * 100).toFixed(1)}%, ${s.clips} clips (${s.clip_seconds.toFixed(2)} s)`,
  );
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
