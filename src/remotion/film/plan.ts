// The chapter engine's one source of truth (claudia.gallery's toolkit wiki, item 18; rulings
// R1, R3, R4). `buildPlan` turns the board, the edit list, the analysis and the brand into a
// plain JSON plan; `frameState` says what one frame draws, as a pure function of the frame
// number and the plan. The composition draws exactly what `frameState` returns, and film:chapter
// runs the same two functions in Node for the tokens sidecar and the sound events, so the
// sidecar and the pixels come from one function.
//
// No React, no DOM, no node: this file is bundled for the browser and imported by the commands.
// Nothing here keeps state between calls: no Math.random, no clock, no module-level variable.

export const FILM_FPS = 24;
export const DITHER_FRAMES = 12; // R4
export const RAMP_FRAMES = 3; // R4: a full-frame luminance change ramps over at least three frames
export const TYPE_LEAD_FRAMES = 6; // lyric typing finishes six frames before the cut
export const CPS = { min: 16, base: 24, max: 40 }; // typing speed, characters a second
export const MAX_ACCENTS = 2; // the accent on at most two elements per frame

export const TYPE_MODES = ["subtitle", "coverline", "masthead", "stack", "mass"] as const;
export const DEVICE_KINDS = ["counter", "label", "terminal", "chart", "strike", "spec-sheet"] as const;
export const TREATMENTS = ["push", "drift", "parallax-left", "parallax-right", "rise", "settle"] as const;
export type TypeMode = (typeof TYPE_MODES)[number];
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Treatment = (typeof TREATMENTS)[number];
export type Mark = "accent" | "strike" | "mono" | null;

// The sound each event kind plays in film:mix (film_py/sounds.py makes them).
export const SOUNDS = ["tick", "stamp", "type", "whoosh"] as const;
export type SoundKind = (typeof SOUNDS)[number];
const DEVICE_SOUND: Record<DeviceKind, SoundKind> = {
  counter: "tick",
  label: "stamp",
  terminal: "type",
  chart: "tick",
  strike: "stamp",
  "spec-sheet": "type",
};
const SOUND_GAIN: Record<SoundKind, number> = { tick: 0.35, stamp: 0.5, type: 0.3, whoosh: 0.45 };

// ---------------------------------------------------------------------------------------------
// Display tokens (wiki/formats): `TEXT|n` shows TEXT for the next n sung words (n defaults to 1;
// `|0` rides on the next token); `*x*` accent, `~x~` strike-through, `_x_` mono.

export type DisplayToken = { text: string; count: number; mark: Mark };

export function parseTokens(text: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    if (raw === "") continue;
    const counted = /^(.*)\|(\d+)$/.exec(raw);
    let body = counted ? counted[1] : raw;
    const count = counted ? Number(counted[2]) : 1;
    let mark: Mark = null;
    const marked = /^([*~_])(.+)\1([^\p{L}\p{N}]*)$/u.exec(body);
    if (marked) {
      mark = marked[1] === "*" ? "accent" : marked[1] === "~" ? "strike" : "mono";
      body = marked[2] + marked[3];
    }
    tokens.push({ text: body, count, mark });
  }
  return tokens;
}

// A display line as plain text: the markers and counts stripped.
export const plainText = (text: string): string =>
  parseTokens(text)
    .map((t) => t.text)
    .filter((t) => t !== "")
    .join(" ");

// The lyric files' parser (wiki/formats): blank lines and lines starting with `[` are skipped.
export function lyricLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("["));
}

// ---------------------------------------------------------------------------------------------
// Time. A frame shows song time F / 24; a thing timed at t shows from the first frame at or
// after t ("a cut shows on the first frame at or after its time").

export const frameAt = (t: number): number => Math.ceil(t * FILM_FPS - 1e-6) + 0; // + 0: never -0
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// Sixteenths from the beat map: the beats, their midpoints (eighths) and the midpoints of
// those, extended by the last spacing past the ends so a device near the edge still steps.
export function sixteenthGrid(beats: number[], duration: number): number[] {
  const b = [...beats].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (b.length < 2) return b.map(r4);
  const grid: number[] = [];
  const first = (b[1] - b[0]) / 4;
  for (let t = b[0] - first; t > -first && grid.length < 4096; t -= first) grid.unshift(t);
  for (let i = 0; i + 1 < b.length; i++) {
    const d = (b[i + 1] - b[i]) / 4;
    for (let k = 0; k < 4; k++) grid.push(b[i] + k * d);
  }
  const last = (b[b.length - 1] - b[b.length - 2]) / 4;
  for (let t = b[b.length - 1]; t <= duration + 1 && grid.length < 65536; t += last) grid.push(t);
  return grid.filter((t) => t >= 0).map(r4);
}

// Grid points after `from` and at or before `t`.
function stepsBetween(grid: number[], from: number, t: number): number {
  let n = 0;
  for (const g of grid) if (g > from + 1e-6 && g <= t + 1e-6) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// The plan.

export type Palette = { black: string; white: string; graphite: string; silver: string; accent: string };

export type Pic =
  | { kind: "video"; src: string; t0: number; in: number; frames: number | null }
  | { kind: "still"; src: string }
  | { kind: "layers"; far: string; mid: string; near: string; treatment: Treatment; t0: number; t1: number }
  | { kind: "black" };

export type PlanToken = { text: string; words: number[]; at: number; mark: Mark };
export type Block = {
  mode: TypeMode;
  line: number | null;
  text: string;
  tokens: PlanToken[];
  from: number; // frames, song clock
  to: number;
  cps: number;
  placement: string | null;
};
export type Anchor = { slot: string } | { x: number; y: number };
export type PlanDevice = {
  kind: DeviceKind;
  key: string;
  at: number; // song seconds
  from: number;
  to: number;
  anchor: Anchor;
  params: Record<string, unknown>;
  line: number | null;
};
export type PlanShot = {
  id: string;
  t0: number;
  t1: number;
  from: number;
  to: number;
  tier: string;
  pics: { from: number; pic: Pic }[];
  transition: "cut" | "dither";
  blocks: Block[];
  devices: PlanDevice[];
  chromeOff: boolean;
  accent: string;
  design: boolean;
};
export type Plan = {
  version: 1;
  fps: number;
  chapter: string;
  t0: number;
  t1: number;
  from: number; // the chapter's first frame on the song clock
  to: number; // one past its last
  shots: PlanShot[]; // every board shot, in time order (neighbours draw under dithers and ramps)
  cards: [number, number][]; // full-frame card spans, merged, frames on the song clock
  grid: number[];
  beats: number[];
  downbeats: number[];
  palette: Palette;
  ramp: boolean;
  words: { i: number; line: number; t0: number; t1: number }[];
};

export type Media = {
  plates: Record<string, string>; // plate key -> staged still
  layers: Record<string, { far: string; mid: string; near: string }>; // plate key -> staged layers
  clips: Record<string, string>; // edl take id (W01-t2) -> staged video
  footage: Record<string, string>; // footage file name -> staged video
  frames: Record<string, number>; // staged video -> its length in frames at 24 fps
};

export type PlanInputs = {
  chapter: string;
  board: unknown;
  edl: unknown;
  words: unknown;
  beats: unknown;
  hits: unknown;
  display: string;
  palette: unknown;
  media: Media;
  ramp?: boolean;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const q = (v: unknown) => JSON.stringify(v);

// The take id the edit list names (`W01-t2`, `W01-c1-t1`) as its clip and take number.
export function takeOf(id: string): { clip: string; n: number } | null {
  const m = /^(.+)-t(\d+)$/.exec(id);
  return m ? { clip: m[1], n: Number(m[2]) } : null;
}

// The palette from brand/palette.json: `{name: {hex}}` (or `{name: "#hex"}`). The accent is the
// palette's `accent`, else its `productGreen`; a board accent is used only when the palette
// lists that colour, so every colour drawn comes from the brand.
export function readPalette(raw: unknown): { palette: Palette | null; problems: string[]; hexes: string[] } {
  const hex = (key: string): string | null => {
    if (!isObj(raw)) return null;
    const v = raw[key];
    const h = isObj(v) ? str(v.hex) : str(v);
    return h && /^#[0-9A-Fa-f]{6}$/.test(h) ? h : null;
  };
  const hexes = isObj(raw) ? Object.keys(raw).map(hex).filter((h): h is string => h !== null) : [];
  const want = { black: hex("black"), white: hex("warmWhite") ?? hex("white"), graphite: hex("graphite"), silver: hex("silver"), accent: hex("accent") ?? hex("productGreen") };
  const problems = Object.entries(want)
    .filter(([, v]) => v === null)
    .map(([k]) => `palette.json has no ${k === "white" ? "warmWhite" : k === "accent" ? "accent or productGreen" : k} colour`);
  return { palette: problems.length ? null : (want as Palette), problems, hexes };
}

export function buildPlan(input: PlanInputs): { plan: Plan | null; problems: string[] } {
  const problems: string[] = [];
  const board = isObj(input.board) ? input.board : {};
  const edl = isObj(input.edl) ? input.edl : {};
  const { palette, problems: paletteProblems, hexes } = readPalette(input.palette);
  problems.push(...paletteProblems.map((p) => `--brand: ${p}`));

  const words = (isObj(input.words) && Array.isArray(input.words.words) ? input.words.words : [])
    .filter(isObj)
    .map((w, k) => ({ i: num(w.i) ?? k, line: num(w.line) ?? -1, t0: num(w.t0) ?? 0, t1: num(w.t1) ?? 0 }))
    .sort((a, b) => a.i - b.i);
  const beatsRaw = isObj(input.beats) ? input.beats : {};
  const beats = (Array.isArray(beatsRaw.beats) ? beatsRaw.beats : []).map(num).filter((x): x is number => x !== null);
  const downbeats = (Array.isArray(beatsRaw.downbeats) ? beatsRaw.downbeats : []).map(num).filter((x): x is number => x !== null);
  const hitsRaw = isObj(input.hits) ? input.hits : {};
  const hitTimes = (Array.isArray(hitsRaw.hits) ? hitsRaw.hits : []).map((h) => (isObj(h) ? num(h.t) : num(h))).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const drumTimes = [...(Array.isArray(hitsRaw.kick) ? hitsRaw.kick : []), ...(Array.isArray(hitsRaw.snare) ? hitsRaw.snare : [])]
    .map(num)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const display = lyricLines(input.display);
  const duration = num(board.duration) ?? 0;

  const chapters = (Array.isArray(board.chapters) ? board.chapters : []).filter(isObj);
  const chapter = chapters.find((c) => c.id === input.chapter);
  if (!chapter) problems.push(`--chapter: the board has no chapter ${q(input.chapter)}`);
  const ct0 = num(chapter?.t0) ?? 0;
  const ct1 = num(chapter?.t1) ?? 0;
  const chapterAccent = str(chapter?.accent);

  const rawShots = (Array.isArray(board.shots) ? board.shots : []).filter(isObj).sort((a, b) => (num(a.t0) ?? 0) - (num(b.t0) ?? 0));
  const inChapter = (s: Obj) => (num(s.t0) ?? 0) < ct1 - 1e-6 && (num(s.t1) ?? 0) > ct0 + 1e-6;
  const lineWords = (line: number) => words.filter((w) => w.line === line);

  const shots: PlanShot[] = [];
  for (let k = 0; k < rawShots.length; k++) {
    const s = rawShots[k];
    const id = str(s.id) ?? `#${k}`;
    const checked = chapter !== undefined && inChapter(s);
    // Shots outside the chapter matter only as neighbours (a dither's outgoing picture, a card's
    // ramp); their problems are reported where their own chapter is rendered.
    const report = (line: string) => {
      if (checked) problems.push(line);
    };
    const t0 = num(s.t0) ?? 0;
    const t1 = num(s.t1) ?? 0;
    const tier = str(s.motion_tier) ?? "still";
    const entry = edl[id];
    const pics: { from: number; pic: Pic }[] = [];
    let design = false;
    const platePic = (key: string): Pic | null => {
      if (tier === "plate3d") {
        const layers = input.media.layers[key];
        const treatment = str(s.treatment);
        if (!treatment || !(TREATMENTS as readonly string[]).includes(treatment)) {
          report(`--board: ${q(id)} is plate3d and needs a treatment (one of ${TREATMENTS.join(", ")})`);
          return null;
        }
        if (!layers) {
          report(`--plates: ${q(id)} is plate3d and plate ${q(key)} has no near, mid and far mattes`);
          return null;
        }
        return { kind: "layers", ...layers, treatment: treatment as Treatment, t0, t1 };
      }
      const src = input.media.plates[key];
      if (!src) {
        report(`--plates: ${q(id)} plays plate ${q(key)}, which is not in the plates folder`);
        return null;
      }
      return { kind: "still", src };
    };
    if (!isObj(entry)) {
      report(`--edl: ${q(id)} has no entry`);
    } else if (Array.isArray(entry.segs)) {
      for (const seg of entry.segs.filter(isObj)) {
        const segT0 = num(seg.t0) ?? t0;
        const clip = str(seg.clip);
        const plate = str(seg.plate);
        let pic: Pic | null = null;
        if (clip !== null) {
          const src = input.media.clips[clip];
          if (!src) report(`--clips: ${q(id)} plays take ${q(clip)}, which is not in the clips folder`);
          else pic = { kind: "video", src, t0: segT0, in: num(seg.in) ?? 0, frames: input.media.frames[src] ?? null };
        } else if (plate !== null) {
          const src = input.media.plates[plate];
          if (!src) report(`--plates: ${q(id)} plays plate ${q(plate)}, which is not in the plates folder`);
          else pic = { kind: "still", src };
        }
        if (pic) pics.push({ from: frameAt(segT0), pic });
      }
    } else if (typeof entry.plate === "string") {
      const pic = platePic(entry.plate);
      if (pic) pics.push({ from: frameAt(t0), pic });
    } else if (typeof entry.footage === "string") {
      const src = input.media.footage[entry.footage];
      if (!src) report(`--footage: ${q(id)} plays ${q(entry.footage)}, which is not in the footage folder`);
      else pics.push({ from: frameAt(t0), pic: { kind: "video", src, t0, in: 0, frames: input.media.frames[src] ?? null } });
    } else if (entry.design === true) {
      design = true;
      pics.push({ from: frameAt(t0), pic: { kind: "black" } });
    } else {
      report(`--edl: ${q(id)} has an entry that is not segs, plate, footage or design`);
    }
    pics.sort((a, b) => a.from - b.from);
    const from = frameAt(t0);
    const to = frameAt(t1);

    // Type: a lyric entry's tokens consume its line's sung words in order and appear on them;
    // a lyric block runs from its first token to the next lyric block (one lyric block a frame).
    const blocks: Block[] = [];
    const types = (Array.isArray(s.type) ? s.type : []).filter(isObj);
    types.forEach((entry, n) => {
      const mode = str(entry.mode) as TypeMode;
      if (!(TYPE_MODES as readonly string[]).includes(mode)) {
        report(`--board: ${q(id)} type[${n}] mode ${q(entry.mode)} is not one of ${TYPE_MODES.join(", ")}`);
        return;
      }
      const line = num(entry.line);
      let text = str(entry.text) ?? "";
      if (line !== null && text.trim() === "") text = display[line] ?? "";
      const parsed = parseTokens(text);
      const placement = str(entry.placement);
      if (line === null) {
        blocks.push({ mode, line, text, tokens: parsed.map((p) => ({ text: p.text, words: [], at: t0, mark: p.mark })), from, to, cps: CPS.base, placement });
        return;
      }
      const sung = lineWords(line);
      const consumed = parsed.reduce((sum, p) => sum + p.count, 0);
      if (consumed !== sung.length) {
        report(`--board: ${q(id)} type[${n}] shows ${consumed} sung word${consumed === 1 ? "" : "s"}, line ${line} has ${sung.length} in words.json`);
        return;
      }
      let w = 0;
      const tokens: PlanToken[] = parsed.map((p) => {
        const ws = sung.slice(w, w + p.count);
        w += p.count;
        return { text: p.text, words: ws.map((x) => x.i), at: ws.length ? ws[0].t0 : Number.NaN, mark: p.mark };
      });
      // `|0` rides on the next token (on the one before when it is last).
      for (let i = tokens.length - 1; i >= 0; i--) if (Number.isNaN(tokens[i].at)) tokens[i].at = i + 1 < tokens.length ? tokens[i + 1].at : Number.NaN;
      for (let i = 0; i < tokens.length; i++) if (Number.isNaN(tokens[i].at)) tokens[i].at = i > 0 ? tokens[i - 1].at : t0;
      const first = Math.min(...tokens.map((t) => t.at));
      blocks.push({ mode, line, text, tokens, from: Math.max(from, frameAt(first)), to, cps: CPS.base, placement });
    });
    const lyric = blocks.filter((b) => b.line !== null).sort((a, b) => a.from - b.from);
    for (let i = 0; i + 1 < lyric.length; i++) lyric[i].to = Math.max(lyric[i].from, lyric[i + 1].from);
    for (const b of blocks) b.cps = typingSpeed(b);

    // Devices: each enters on its key time and runs to the shot's end.
    const devices: PlanDevice[] = [];
    (Array.isArray(s.devices) ? s.devices : []).filter(isObj).forEach((d, n) => {
      const kind = str(d.kind) as DeviceKind;
      if (!(DEVICE_KINDS as readonly string[]).includes(kind)) {
        report(`--board: ${q(id)} devices[${n}] kind ${q(d.kind)} is not one of ${DEVICE_KINDS.join(", ")}`);
        return;
      }
      const line = num(d.line);
      let params = isObj(d.params) ? d.params : {};
      // A strike with no text of its own strikes the type text of its line.
      if (kind === "strike" && typeof params.text !== "string") {
        const typed = blocks.find((b) => b.line === line);
        params = { ...params, text: typed ? plainText(typed.text) : "" };
      }
      const named = line !== null ? lineWords(line)[0] : undefined;
      const ref = named ? named.t0 : t0;
      const key = str(d.key) ?? "W";
      const after = (list: number[]) => list.find((x) => x >= ref - 1e-6);
      let at = ref;
      if (key === "B") at = after(beats) ?? ref;
      else if (key === "H") at = after(hitTimes) ?? after(drumTimes) ?? ref;
      else if (key === "F") at = num(params.at) !== null ? (num(params.at) as number) / FILM_FPS : ref;
      else if (key === "T") at = num(params.at) ?? ref;
      at = Math.max(at, t0);
      const a = d.anchor;
      const anchor: Anchor = isObj(a) && num(a.x) !== null && num(a.y) !== null ? { x: num(a.x) as number, y: num(a.y) as number } : { slot: (isObj(a) ? str(a.slot) : str(a)) ?? "right" };
      devices.push({ kind, key, at: r4(at), from: Math.max(from, frameAt(at)), to, anchor, params, line });
    });

    const wanted = str(s.accent) ?? chapterAccent;
    const accent = palette ? (wanted && hexes.some((h) => h.toLowerCase() === wanted.toLowerCase()) ? wanted : palette.accent) : "#000000";
    shots.push({
      id,
      t0,
      t1,
      from,
      to,
      tier,
      pics,
      transition: s.transition_in === "dither" ? "dither" : "cut",
      blocks,
      devices,
      chromeOff: typeof s.chrome === "string" && s.chrome.trim().toLowerCase() === "off",
      accent,
      design,
    });
  }

  // Full-frame cards: design shots and masthead or mass blocks, merged where they touch.
  const spans: [number, number][] = [];
  for (const shot of shots) {
    if (shot.design) spans.push([shot.from, shot.to]);
    for (const b of shot.blocks) if ((b.mode === "masthead" || b.mode === "mass") && b.to > b.from) spans.push([b.from, b.to]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const cards: [number, number][] = [];
  for (const span of spans) {
    const last = cards[cards.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else cards.push([span[0], span[1]]);
  }

  if (problems.length > 0 || !palette) return { plan: null, problems };
  return {
    plan: {
      version: 1,
      fps: FILM_FPS,
      chapter: input.chapter,
      t0: ct0,
      t1: ct1,
      from: frameAt(ct0),
      to: frameAt(ct1),
      shots,
      cards,
      grid: sixteenthGrid(beats, Math.max(duration, ct1)),
      beats,
      downbeats,
      palette,
      ramp: input.ramp !== false,
      words,
    },
    problems,
  };
}

// The speed a typed block needs so its last token is whole six frames before the cut: the
// base speed, raised up to the ceiling when the line is long or late.
function typingSpeed(b: Block): number {
  if (b.mode !== "subtitle" && b.mode !== "coverline") return CPS.base;
  const deadline = (b.to - TYPE_LEAD_FRAMES) / FILM_FPS;
  let need = CPS.base;
  for (const t of b.tokens) {
    const start = Math.max(b.from, frameAt(t.at)) / FILM_FPS;
    const room = deadline - start;
    if (room > 0) need = Math.max(need, (t.text.length - 1) / room);
  }
  return clamp(need, CPS.min, CPS.max);
}

// ---------------------------------------------------------------------------------------------
// One frame.

export type DrawnToken = { text: string; words: number[]; shown: number; mark: Mark; scale: number; accent: boolean; spacing: number };
export type DrawnBlock = { mode: TypeMode; line: number | null; placement: string | null; tokens: DrawnToken[]; text: string };
export type DrawnDevice = { kind: DeviceKind; anchor: Anchor; params: Record<string, unknown>; step: number; age: number; accent: boolean; index: number };
export type Layer =
  | { kind: "video"; src: string; frame: number }
  | { kind: "still"; src: string }
  | {
      kind: "layers";
      far: string;
      mid: string;
      near: string;
      move: { far: Move; mid: Move; near: Move };
    }
  | { kind: "black" };
export type Move = { scale: number; x: number; y: number }; // x and y in percent of the frame
export type FrameState = {
  frame: number; // the composition's frame
  song: number; // the frame on the song clock
  t: number;
  shot: string | null;
  under: { layer: Layer; shot: string } | null; // the outgoing picture during a dither
  layer: Layer;
  dither: number | null; // 0..1, the share of the incoming picture's cells shown
  card: number; // 0..1, the full-frame card's opacity over the picture
  blocks: DrawnBlock[];
  devices: DrawnDevice[];
  chrome: { session: string; bar: number; beat: number } | null;
  tokens: { word: number; text: string }[]; // the tokens drawn on this frame (R1)
  accent: string;
};

const ease = (u: number) => u * u * (3 - 2 * u);

// R3: each treatment moves the near, mid and far layers as a pure function of song time, near
// most (4 percent), far least; every layer keeps a 6 percent overscan so no edge shows.
export function treatmentMove(treatment: Treatment, t: number, t0: number, t1: number): { far: Move; mid: Move; near: Move } {
  const u = ease(clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1));
  const depth = { far: 0.25, mid: 0.5, near: 1 };
  const amp = 4; // percent, at the near layer
  const out = {} as { far: Move; mid: Move; near: Move };
  for (const key of ["far", "mid", "near"] as const) {
    const a = amp * depth[key];
    const m: Move = { scale: 1.06, x: 0, y: 0 };
    if (treatment === "push") m.scale = 1.06 * (1 + (a / 100) * u);
    else if (treatment === "settle") m.scale = 1.06 * (1 + (a / 100) * (1 - u));
    else if (treatment === "drift") {
      m.x = -a * 0.6 * (u - 0.5);
      m.y = -a * 0.25 * (u - 0.5);
    } else if (treatment === "parallax-left") m.x = a * (u - 0.5);
    else if (treatment === "parallax-right") m.x = -a * (u - 0.5);
    else if (treatment === "rise") m.y = -a * (u - 0.5);
    out[key] = { scale: r4(m.scale), x: r4(m.x), y: r4(m.y) };
  }
  return out;
}

function layerAt(shot: PlanShot, song: number): Layer {
  let current: Pic = { kind: "black" };
  for (const p of shot.pics) if (p.from <= song) current = p.pic;
  if (shot.pics.length > 0 && song < shot.pics[0].from) current = shot.pics[0].pic;
  const t = song / FILM_FPS;
  if (current.kind === "video") {
    // Clip time at this frame, in whole 24 fps frames; past its end the last frame holds.
    let frame = Math.round((current.in + (t - current.t0)) * FILM_FPS);
    const last = current.frames !== null ? current.frames - 1 : Number.POSITIVE_INFINITY;
    frame = clamp(frame, 0, Math.max(0, last));
    return { kind: "video", src: current.src, frame };
  }
  if (current.kind === "layers") {
    return { kind: "layers", far: current.far, mid: current.mid, near: current.near, move: treatmentMove(current.treatment, t, current.t0, current.t1) };
  }
  return current;
}

// The card's opacity: full inside a card span, ramped over three frames on each side (R4).
export function cardOpacity(plan: Plan, song: number): number {
  let best = 0;
  for (const [a, b] of plan.cards) {
    if (song >= a && song < b) return 1;
    if (!plan.ramp) continue;
    if (song < a && a - song <= RAMP_FRAMES) best = Math.max(best, (RAMP_FRAMES + 1 - (a - song)) / (RAMP_FRAMES + 1));
    if (song >= b && song - b < RAMP_FRAMES) best = Math.max(best, (RAMP_FRAMES - (song - b)) / (RAMP_FRAMES + 1));
  }
  return r4(best);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function chromeAt(plan: Plan, t: number): { session: string; bar: number; beat: number } {
  const seconds = Math.max(0, Math.floor(t + 1e-6));
  const session = `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
  const beatsDone = plan.beats.filter((b) => b <= t + 1e-6);
  const downs = plan.downbeats.filter((d) => d <= t + 1e-6);
  const bar = downs.length;
  const lastDown = downs.length ? downs[downs.length - 1] : null;
  const beat = lastDown === null ? beatsDone.length : beatsDone.filter((b) => b >= lastDown - 1e-6).length;
  return { session, bar, beat };
}

export function shotAt(plan: Plan, song: number): number {
  let index = -1;
  for (let k = 0; k < plan.shots.length; k++) if (plan.shots[k].from <= song && song < plan.shots[k].to) index = k;
  return index;
}

// What composition frame `frame` draws. Every value comes from the plan and the frame number.
export function frameState(plan: Plan, frame: number): FrameState {
  const song = plan.from + frame;
  const t = song / FILM_FPS;
  const k = shotAt(plan, song);
  const shot = k >= 0 ? plan.shots[k] : null;
  const card = cardOpacity(plan, song);
  const state: FrameState = {
    frame,
    song,
    t: r4(t),
    shot: shot?.id ?? null,
    under: null,
    layer: shot ? layerAt(shot, song) : { kind: "black" },
    dither: null,
    card,
    blocks: [],
    devices: [],
    chrome: null,
    tokens: [],
    accent: shot?.accent ?? plan.palette.accent,
  };
  if (!shot) return state;

  // A dither: the outgoing shot keeps playing underneath for twelve frames while the incoming
  // shot's cells switch on in ordered-dither order.
  const into = song - shot.from;
  if (shot.transition === "dither" && into < DITHER_FRAMES) {
    const prev = k > 0 ? plan.shots[k - 1] : null;
    state.under = prev ? { layer: layerAt(prev, song), shot: prev.id } : { layer: { kind: "black" }, shot: "" };
    state.dither = r4((into + 1) / DITHER_FRAMES);
  }

  // Accents in drawing order: type first, then devices; the first two keep the accent.
  let accents = 0;
  const takeAccent = () => (accents < MAX_ACCENTS ? (accents++, true) : false);

  for (const b of shot.blocks) {
    if (song < b.from || song >= b.to) continue;
    const isCard = b.mode === "masthead" || b.mode === "mass";
    if (isCard && card < 1) continue; // card type shows only on the full card
    const typed = b.mode === "subtitle" || b.mode === "coverline";
    const deadline = (b.to - TYPE_LEAD_FRAMES) / FILM_FPS;
    const tokens: DrawnToken[] = [];
    for (const tok of b.tokens) {
      const appear = Math.max(b.from, frameAt(tok.at));
      if (song < appear) continue;
      const since = song - appear;
      let shown = tok.text.length;
      if (typed && t < deadline - 1e-9) shown = Math.min(tok.text.length, 1 + Math.floor((since / FILM_FPS) * b.cps + 1e-9));
      const singing = tok.words.some((i) => {
        const w = plan.words.find((x) => x.i === i);
        return w !== undefined && w.t0 <= t + 1e-6 && t < w.t1;
      });
      const wantsAccent = tok.mark === "accent" || (b.mode === "subtitle" && singing);
      const slam = b.mode === "masthead" || b.mode === "stack" || b.mode === "mass" ? Math.max(0, RAMP_FRAMES - 1 - since) : 0;
      tokens.push({
        text: tok.text,
        words: tok.words,
        shown,
        mark: tok.mark,
        scale: r4(1 + 0.2 * slam),
        accent: wantsAccent ? takeAccent() : false,
        spacing: b.mode === "coverline" ? r4(Math.max(0, 0.12 * (1 - since / 4))) : 0,
      });
      for (const i of tok.words) state.tokens.push({ word: i, text: tok.text });
    }
    if (tokens.length > 0 || b.line === null) state.blocks.push({ mode: b.mode, line: b.line, placement: b.placement, tokens, text: b.text });
  }

  shot.devices.forEach((d, index) => {
    if (song < d.from || song >= d.to) return;
    const wantsAccent = d.kind === "label" || d.kind === "counter" || d.kind === "chart" || d.kind === "strike";
    state.devices.push({
      kind: d.kind,
      anchor: d.anchor,
      params: d.params,
      step: stepsBetween(plan.grid, d.at, t),
      age: song - d.from,
      accent: wantsAccent ? takeAccent() : false,
      index,
    });
  });

  if (!shot.chromeOff && card === 0) state.chrome = chromeAt(plan, t);
  return state;
}

// The tokens sidecar (R1) for composition frames [a, b]: what each frame draws, by word.
export function tokensSidecar(plan: Plan, a: number, b: number): { fps: number; chapter: string; frames: { t: number; tokens: { word: number; text: string }[] }[] } {
  const frames = [];
  for (let f = a; f <= b; f++) {
    const s = frameState(plan, f);
    frames.push({ t: s.t, tokens: s.tokens });
  }
  return { fps: FILM_FPS, chapter: plan.chapter, frames };
}

// The sound events the mix places for this chapter: each device's entrance, each dither and
// each card that comes in, at song time, inside [t0, t1).
export function audioEvents(plan: Plan, t0 = plan.t0, t1 = plan.t1): { t: number; kind: SoundKind; gain: number; shot: string; what: string }[] {
  const events: { t: number; kind: SoundKind; gain: number; shot: string; what: string }[] = [];
  const inside = (t: number) => t >= t0 - 1e-6 && t < t1 - 1e-6;
  for (const shot of plan.shots) {
    if (shot.transition === "dither" && inside(shot.t0)) events.push({ t: r4(shot.from / FILM_FPS), kind: "whoosh", gain: SOUND_GAIN.whoosh, shot: shot.id, what: "dither" });
    for (const d of shot.devices) {
      const at = d.from / FILM_FPS;
      if (d.from < shot.to && inside(at)) events.push({ t: r4(at), kind: DEVICE_SOUND[d.kind], gain: SOUND_GAIN[DEVICE_SOUND[d.kind]], shot: shot.id, what: d.kind });
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

// The ordered-dither threshold of a cell (an 8x8 Bayer matrix): a cell shows the incoming
// picture once the dither's progress passes it, so each cell switches once and never back.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER2 = [0, 2, 3, 1];
export function bayer(x: number, y: number): number {
  const a = BAYER4[(y % 4) * 4 + (x % 4)];
  const b = BAYER2[(Math.floor(y / 4) % 2) * 2 + (Math.floor(x / 4) % 2)];
  return (a * 4 + b + 0.5) / 64;
}

// The CSS clip path of the incoming picture's cells at progress p: rows of runs of cells.
export function ditherPath(width: number, height: number, cell: number, p: number): string {
  if (p >= 1) return `M0 0H${width}V${height}H0Z`;
  const parts: string[] = [];
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let y = 0; y < rows; y++) {
    let start = -1;
    for (let x = 0; x <= cols; x++) {
      const on = x < cols && bayer(x, y) < p;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        parts.push(`M${start * cell} ${y * cell}H${x * cell}V${(y + 1) * cell}H${start * cell}Z`);
        start = -1;
      }
    }
  }
  return parts.length ? parts.join("") : "M0 0Z";
}
