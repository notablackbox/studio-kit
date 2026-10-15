import { readFileSync } from "node:fs";
import { Refused, shown } from "./cli.ts";
import { DEVICE_SLOTS } from "../../remotion/film/plan.ts";

// The board, `shots.json`, in claudia.gallery's formats (wiki/formats, "The board"), with the
// kit's v0.2.0 additions: a shot's `genuine` and `footage` (real product footage, checked
// against walk-report.json or recordings.json), and a chapter's `box`. Read by film:audit,
// film:sheet and film:edl; a board that does not fit the schema is refused (exit 2), one line
// per problem. Creative gaps (a missing framing, a TODO) are not schema problems: the audit's
// gates report them.

export const FRAMINGS = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "FS", "EWS", "OTS"] as const;
export const TIERS = ["still", "plate3d", "motion", "sung"] as const;
export const TYPE_MODES = ["subtitle", "coverline", "masthead", "stack", "mass"] as const;
export const DEVICE_KINDS = ["counter", "label", "terminal", "chart", "strike", "spec-sheet"] as const; // R4
export const DEVICE_KEYS = ["W", "B", "H", "F", "T"] as const;
export const TREATMENTS = ["push", "drift", "parallax-left", "parallax-right", "rise", "settle"] as const; // R3
export const TRANSITIONS = ["cut", "dither"] as const; // R4

export type TypeEntry = { line: number | null; mode: (typeof TYPE_MODES)[number]; text: string; placement?: unknown };
export type Device = { kind: (typeof DEVICE_KINDS)[number]; anchor?: unknown; params?: Record<string, unknown>; key: (typeof DEVICE_KEYS)[number]; line: number | null };
export type Shot = {
  id: string;
  t0: number;
  t1: number;
  section?: string;
  lines: number[];
  set?: string;
  lead_on_screen: boolean;
  framing?: (typeof FRAMINGS)[number] | null;
  action?: string;
  camera?: string;
  motion_tier?: (typeof TIERS)[number];
  plate: string | null;
  clip: string | null;
  prompt?: string;
  type: TypeEntry[];
  devices: Device[];
  treatment: (typeof TREATMENTS)[number] | null;
  transition_in?: (typeof TRANSITIONS)[number];
  chrome?: string;
  accent?: string;
  hit?: number;
  notes?: string;
  genuine: boolean;
  footage: string | null;
};
export type Chapter = { id: string; name?: string; t0: number; t1: number; sections: string[]; accent?: string; set?: string; box?: string };
export type Plate = { plate: string; set?: string; prompt?: string; aspect?: string; used_by: string[] };
export type Board = { version: 1; duration: number; chapters: Chapter[]; shots: Shot[]; plates: Plate[] };

const TOP = ["version", "duration", "chapters", "shots", "plates"];
const SHOT = [
  "id", "t0", "t1", "section", "lines", "set", "lead_on_screen", "framing", "action", "camera", "motion_tier", "plate", "clip",
  "prompt", "type", "devices", "treatment", "transition_in", "chrome", "accent", "hit", "notes", "genuine", "footage",
];
const TYPE = ["line", "mode", "text", "placement"];
const DEVICE = ["kind", "anchor", "params", "key", "line"];
const CHAPTER = ["id", "name", "t0", "t1", "sections", "accent", "set", "box"];
const PLATE = ["plate", "set", "prompt", "aspect", "used_by"];

// A plate key, a clip id or a chapter id names a file (`<plates>/<plate>.png`,
// `<clips>/<clip>.json`, `<out>/<chapter>.mp4`): no separators, no leading dot.
export const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHOT_ID = /^s\d{3}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const BOX_MAX = 60;
const SHOWN_MAX = 20;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

// Checks a parsed board; returns the problems, each a line without the flag's prefix.
export function boardProblems(raw: unknown): string[] {
  const problems: string[] = [];
  const bad = (path: string, value: unknown, want: string) => problems.push(`${path} is ${shown(value)}, want ${want}`);
  const unknown = (path: string, entry: Obj, allowed: string[]) => {
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) problems.push(`${path} has an unknown field ${shown(key)}`);
  };
  const oneOf = (list: readonly string[]) => `one of ${list.join(", ")}`;
  const optString = (path: string, entry: Obj, key: string) => {
    if (key in entry && typeof entry[key] !== "string") bad(`${path}.${key}`, entry[key], "text");
  };

  if (!isObject(raw)) return ["is not a JSON object"];
  unknown("the board", raw, TOP);
  if (raw.version !== 1) bad("version", raw.version, "1");
  if (!isNumber(raw.duration) || raw.duration <= 0) bad("duration", raw.duration, "seconds above 0");
  if (!Array.isArray(raw.shots) || raw.shots.length === 0) {
    problems.push("shots is not a list of shots");
  } else {
    const ids = new Set<string>();
    raw.shots.forEach((shot, n) => {
      const at = `shots[${n}]`;
      if (!isObject(shot)) {
        problems.push(`${at} is not an object`);
        return;
      }
      unknown(at, shot, SHOT);
      if (typeof shot.id !== "string" || !SHOT_ID.test(shot.id)) bad(`${at}.id`, shot.id, "s and three digits (s001)");
      else if (ids.has(shot.id)) problems.push(`${at}.id ${shown(shot.id)} is used twice`);
      else ids.add(shot.id);
      for (const key of ["t0", "t1"]) if (!isNumber(shot[key]) || (shot[key] as number) < 0) bad(`${at}.${key}`, shot[key], "seconds");
      if (isNumber(shot.t0) && isNumber(shot.t1) && !(shot.t0 < shot.t1)) problems.push(`${at} ends at ${shot.t1}, not after its start ${shot.t0}`);
      for (const key of ["section", "set", "action", "camera", "prompt", "chrome", "notes"]) optString(at, shot, key);
      if ("lines" in shot && (!Array.isArray(shot.lines) || !shot.lines.every(isIndex))) bad(`${at}.lines`, shot.lines, "a list of line numbers");
      if ("lead_on_screen" in shot && typeof shot.lead_on_screen !== "boolean") bad(`${at}.lead_on_screen`, shot.lead_on_screen, "true or false");
      if ("genuine" in shot && typeof shot.genuine !== "boolean") bad(`${at}.genuine`, shot.genuine, "true or false");
      if (shot.framing != null && !(FRAMINGS as readonly unknown[]).includes(shot.framing)) bad(`${at}.framing`, shot.framing, oneOf(FRAMINGS));
      if ("motion_tier" in shot && !(TIERS as readonly unknown[]).includes(shot.motion_tier)) bad(`${at}.motion_tier`, shot.motion_tier, oneOf(TIERS));
      for (const key of ["plate", "clip"]) {
        if (shot[key] != null && (typeof shot[key] !== "string" || !KEY.test(shot[key] as string))) bad(`${at}.${key}`, shot[key], "a key of letters, digits, dot, dash or underscore, or null");
      }
      if (shot.footage != null && (typeof shot.footage !== "string" || shot.footage === "")) bad(`${at}.footage`, shot.footage, "a file name or null");
      if (shot.treatment != null && !(TREATMENTS as readonly unknown[]).includes(shot.treatment)) bad(`${at}.treatment`, shot.treatment, `${oneOf(TREATMENTS)}, or null`);
      if ("transition_in" in shot && !(TRANSITIONS as readonly unknown[]).includes(shot.transition_in)) bad(`${at}.transition_in`, shot.transition_in, oneOf(TRANSITIONS));
      if ("accent" in shot && (typeof shot.accent !== "string" || !HEX.test(shot.accent))) bad(`${at}.accent`, shot.accent, "a hex colour (#D97757)");
      if ("hit" in shot && (!isNumber(shot.hit) || shot.hit < 0)) bad(`${at}.hit`, shot.hit, "seconds");
      if ("type" in shot) {
        if (!Array.isArray(shot.type)) bad(`${at}.type`, shot.type, "a list");
        else
          shot.type.forEach((entry, k) => {
            const p = `${at}.type[${k}]`;
            if (!isObject(entry)) return void problems.push(`${p} is not an object`);
            unknown(p, entry, TYPE);
            if (entry.line != null && !isIndex(entry.line)) bad(`${p}.line`, entry.line, "a line number or null");
            if (!(TYPE_MODES as readonly unknown[]).includes(entry.mode)) bad(`${p}.mode`, entry.mode, oneOf(TYPE_MODES));
            if (typeof entry.text !== "string") bad(`${p}.text`, entry.text, "text");
          });
      }
      if ("devices" in shot) {
        if (!Array.isArray(shot.devices)) bad(`${at}.devices`, shot.devices, "a list");
        else
          shot.devices.forEach((entry, k) => {
            const p = `${at}.devices[${k}]`;
            if (!isObject(entry)) return void problems.push(`${p} is not an object`);
            unknown(p, entry, DEVICE);
            if (!(DEVICE_KINDS as readonly unknown[]).includes(entry.kind)) bad(`${p}.kind`, entry.kind, oneOf(DEVICE_KINDS));
            if (!(DEVICE_KEYS as readonly unknown[]).includes(entry.key)) bad(`${p}.key`, entry.key, oneOf(DEVICE_KEYS));
            if (entry.line != null && !isIndex(entry.line)) bad(`${p}.line`, entry.line, "a line number or null");
            if ("params" in entry && !isObject(entry.params)) bad(`${p}.params`, entry.params, "an object");
            if ("anchor" in entry && entry.anchor !== null) {
              const a = entry.anchor;
              const xy = isObject(a) && isNumber(a.x) && isNumber(a.y);
              const slot = isObject(a) ? a.slot : a;
              const named = typeof slot === "string" && (DEVICE_SLOTS as readonly string[]).includes(slot);
              const where = typeof shot.id === "string" ? ` (shot ${shown(shot.id)})` : "";
              if (!xy && !named) {
                if (isObject(a) && "slot" in a) bad(`${p}.anchor.slot`, slot, `${oneOf(DEVICE_SLOTS)}${where}`);
                else bad(`${p}.anchor`, a, `a slot (${DEVICE_SLOTS.join(", ")}) or {x, y} in percent${where}`);
              }
            }
          });
      }
    });
  }
  if ("chapters" in raw) {
    const ids = new Set<string>();
    if (!Array.isArray(raw.chapters)) bad("chapters", raw.chapters, "a list");
    else
      raw.chapters.forEach((chapter, n) => {
        const at = `chapters[${n}]`;
        if (!isObject(chapter)) return void problems.push(`${at} is not an object`);
        unknown(at, chapter, CHAPTER);
        // A chapter id names its outputs (<chapter>.mp4, .tokens.json, .audio.json): a plain key,
        // so it never leaves --out, and used once, so --chapter finds the one it means.
        if (typeof chapter.id !== "string" || !KEY.test(chapter.id)) bad(`${at}.id`, chapter.id, "a key of letters, digits, dot, dash or underscore");
        else if (ids.has(chapter.id)) problems.push(`${at}.id ${shown(chapter.id)} is used twice`);
        else ids.add(chapter.id);
        for (const key of ["t0", "t1"]) if (!isNumber(chapter[key]) || (chapter[key] as number) < 0) bad(`${at}.${key}`, chapter[key], "seconds");
        if (isNumber(chapter.t0) && isNumber(chapter.t1) && !(chapter.t0 < chapter.t1)) problems.push(`${at} ends at ${chapter.t1}, not after its start ${chapter.t0}`);
        for (const key of ["name", "set"]) optString(at, chapter, key);
        if ("sections" in chapter && (!Array.isArray(chapter.sections) || !chapter.sections.every((s) => typeof s === "string"))) bad(`${at}.sections`, chapter.sections, "a list of section names");
        if ("accent" in chapter && (typeof chapter.accent !== "string" || !HEX.test(chapter.accent))) bad(`${at}.accent`, chapter.accent, "a hex colour (#D97757)");
        if ("box" in chapter && (typeof chapter.box !== "string" || chapter.box.trim() === "" || chapter.box.length > BOX_MAX)) bad(`${at}.box`, chapter.box, `a short text (at most ${BOX_MAX} characters)`);
      });
  }
  if ("plates" in raw) {
    if (!Array.isArray(raw.plates)) bad("plates", raw.plates, "a list");
    else
      raw.plates.forEach((plate, n) => {
        const at = `plates[${n}]`;
        if (!isObject(plate)) return void problems.push(`${at} is not an object`);
        unknown(at, plate, PLATE);
        if (typeof plate.plate !== "string" || !KEY.test(plate.plate)) bad(`${at}.plate`, plate.plate, "a key of letters, digits, dot, dash or underscore");
        for (const key of ["set", "prompt", "aspect"]) optString(at, plate, key);
        if ("used_by" in plate && (!Array.isArray(plate.used_by) || !plate.used_by.every((s) => typeof s === "string"))) bad(`${at}.used_by`, plate.used_by, "a list of shot ids");
      });
  }
  return problems;
}

// The board with its defaults filled in (lists empty, keys null), shots in time order.
function normalise(raw: Obj): Board {
  const shots = (raw.shots as Obj[]).map((s) => ({
    ...s,
    lines: (s.lines as number[] | undefined) ?? [],
    lead_on_screen: (s.lead_on_screen as boolean | undefined) ?? false,
    plate: (s.plate as string | null | undefined) ?? null,
    clip: (s.clip as string | null | undefined) ?? null,
    type: ((s.type as Obj[] | undefined) ?? []).map((t) => ({ ...t, line: (t.line as number | null | undefined) ?? null })),
    devices: ((s.devices as Obj[] | undefined) ?? []).map((d) => ({ ...d, line: (d.line as number | null | undefined) ?? null })),
    treatment: (s.treatment as string | null | undefined) ?? null,
    genuine: (s.genuine as boolean | undefined) ?? false,
    footage: (s.footage as string | null | undefined) ?? null,
  })) as unknown as Shot[];
  shots.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const chapters = ((raw.chapters as Obj[] | undefined) ?? []).map((c) => ({ ...c, sections: (c.sections as string[] | undefined) ?? [] })) as unknown as Chapter[];
  chapters.sort((a, b) => a.t0 - b.t0);
  const plates = ((raw.plates as Obj[] | undefined) ?? []).map((p) => ({ ...p, used_by: (p.used_by as string[] | undefined) ?? [] })) as unknown as Plate[];
  return { version: 1, duration: raw.duration as number, chapters, shots, plates };
}

// Reads and checks `--board`: refused with one line per problem (at most 20, then a count).
export function readBoard(file: string, flag = "--board"): { board: Board; text: string } {
  let text = "";
  let raw: unknown;
  try {
    text = readFileSync(file, "utf8");
    raw = JSON.parse(text);
  } catch {
    throw new Refused([`${flag} is not a JSON file`]);
  }
  const problems = boardProblems(raw);
  if (problems.length > 0) {
    const lines = problems.slice(0, SHOWN_MAX).map((p) => `${flag}: ${p}`);
    if (problems.length > SHOWN_MAX) lines.push(`${flag}: and ${problems.length - SHOWN_MAX} more problems`);
    throw new Refused(lines);
  }
  return { board: normalise(raw as Obj), text };
}

// The lyric files' shared parser (wiki/formats): blank lines and lines starting with `[` are
// skipped; the Nth remaining line is lyric line N.
export function lyricLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("["));
}
