import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, sep } from "node:path";
import { KIT_ROOT, Refused, fromCaller, outProblem, printable, requireFile, shown } from "./cli.ts";
import { KEY, readBoard } from "./board.ts";
import { must, probeVideo } from "./media.ts";
import { FONT_FILES } from "../../remotion/film/fonts.ts";
import { buildPlan, frameAt, takeOf, type Media, type Plan } from "../../remotion/film/plan.ts";
import type { FilmProps } from "../../remotion/film/FilmChapter.tsx";

// What film:chapter, film:reframe and film:history share: the chapter's inputs read and checked
// before any work (exit 2, one line per problem), the plan built from them with the one
// function the composition uses, and the render's public folder staged in temp.

export const CHAPTER_FLAGS = {
  board: { type: "string" },
  edl: { type: "string" },
  words: { type: "string" },
  beats: { type: "string" },
  hits: { type: "string" },
  display: { type: "string" },
  plates: { type: "string" },
  clips: { type: "string" },
  footage: { type: "string" },
  brand: { type: "string" },
  chapter: { type: "string" },
  out: { type: "string" },
  range: { type: "string" },
  // Test-only: cards switch in one frame instead of ramping over three, so a board can be made
  // to flash (the flash check's failing case). Never for a delivery.
  "no-ramp": { type: "boolean" },
} as const;

export type ChapterValues = { [K in keyof typeof CHAPTER_FLAGS]?: (typeof CHAPTER_FLAGS)[K]["type"] extends "boolean" ? boolean : string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const PLATE_EXT = [".png", ".jpg", ".jpeg"];
const MATTES = ["near", "mid", "far"] as const;

export type Prepared = {
  plan: Plan;
  values: ChapterValues;
  inputs: Record<string, string | null>;
  out: string;
  chapter: string;
  frames: [number, number]; // composition frames to render, inclusive
  range: [number, number] | null;
  sources: { kind: "copy"; from: string; to: string }[];
  layers: { plate: string; matte: string; to: string }[];
  texts: Record<string, string>; // staged name -> text
  palette: string;
  fonts: string;
  media: Media;
};

function folder(path: string, flag: string): string {
  try {
    if (statSync(path).isDirectory()) return path;
  } catch {
    // refused below
  }
  throw new Refused([`${flag} is not a folder`]);
}

function readJson(file: string, flag: string, want: (v: unknown) => boolean, what: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(requireFile(file, flag), "utf8"));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused([`${flag} is not ${what}`]);
  }
  if (!want(raw)) throw new Refused([`${flag} is not ${what}`]);
  return raw;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Reads and checks a chapter's inputs; throws Refused before any work.
export function prepareChapter(command: string, values: ChapterValues, options: { required?: string[]; vertical?: boolean } = {}): Prepared {
  const required = options.required ?? [];
  const vertical = options.vertical === true;
  // R-c: cards that switch in one frame exist only to prove the flash check fails.
  if (values["no-ramp"] && process.env.FILM_TEST !== "1") throw new Refused(["--no-ramp is for the kit's tests only (FILM_TEST=1)"]);
  const need = ["board", "edl", "words", "beats", "hits", "display", "plates", "clips", "chapter", "out", ...required];
  const missing = need.filter((k) => !values[k as keyof ChapterValues]);
  if (missing.length > 0) throw new Refused([`${command}: ${need.map((k) => `--${k}`).join(", ")} are required (missing ${missing.map((k) => `--${k}`).join(", ")})`]);
  const v = values as Required<Pick<ChapterValues, "board" | "edl" | "words" | "beats" | "hits" | "display" | "plates" | "clips" | "chapter" | "out">> & ChapterValues;
  const problems: string[] = [];
  const boardFile = requireFile(fromCaller(v.board), "--board");
  const { board, text: boardText } = readBoard(boardFile);
  const edlFile = fromCaller(v.edl);
  const edl = readJson(edlFile, "--edl", isObj, "an edl.json") as Obj;
  const wordsFile = fromCaller(v.words);
  const words = readJson(wordsFile, "--words", (r) => isObj(r) && Array.isArray(r.words), "a words.json") as Obj;
  const beatsFile = fromCaller(v.beats);
  const beats = readJson(beatsFile, "--beats", (r) => isObj(r) && Array.isArray(r.beats), "a beats.json");
  const hitsFile = fromCaller(v.hits);
  const hits = readJson(hitsFile, "--hits", isObj, "a hits.json");
  const displayFile = requireFile(fromCaller(v.display), "--display");
  const display = readFileSync(displayFile, "utf8");
  const platesDir = folder(fromCaller(v.plates), "--plates");
  const clipsDir = folder(fromCaller(v.clips), "--clips");
  const footageDir = v.footage ? folder(fromCaller(v.footage), "--footage") : null;
  const brandDir = folder(v.brand ? fromCaller(v.brand) : join(KIT_ROOT, "brand"), "--brand");
  const paletteFile = join(brandDir, "palette.json");
  const palette = readJson(paletteFile, "--brand", isObj, "a brand folder with palette.json");
  for (const f of FONT_FILES) if (!isFile(join(brandDir, "fonts", f.file))) problems.push(`--brand: fonts/${f.file} is missing`);

  const chapterId = v.chapter;
  const chapter = board.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Refused([`--chapter: the board has no chapter ${shown(chapterId)}`]);

  // The media the chapter's shots and the shot before them (a dither's outgoing picture) need.
  const shots = board.shots;
  const firstIn = shots.findIndex((s) => s.t1 > chapter.t0 + 1e-6 && s.t0 < chapter.t1 - 1e-6);
  const wanted = shots.filter((s, k) => (s.t1 > chapter.t0 + 1e-6 && s.t0 < chapter.t1 - 1e-6) || (firstIn > 0 && k === firstIn - 1));
  const media: Media = { plates: {}, layers: {}, clips: {}, footage: {}, frames: {} };
  const flagged = new Set<string>();
  const flag = (id: string, line: string) => {
    flagged.add(id);
    problems.push(line);
  };
  const sources: Prepared["sources"] = [];
  const layers: Prepared["layers"] = [];
  const realFootage = footageDir ? realpathSync(footageDir) : null;
  // Every key from the edit list names a file: checked with the board's KEY before any path is built.
  const plateKey = (id: string, key: string): boolean => {
    if (KEY.test(key)) return true;
    flag(id, `--edl: ${shown(id)} names plate ${shown(key)}, which is not a plate key`);
    return false;
  };
  const addPlate = (key: string, needLayers: boolean) => {
    const found = PLATE_EXT.map((ext) => join(platesDir, `${key}${ext}`)).find(isFile);
    if (!found) return; // the plan names the missing plate
    if (!media.plates[key]) {
      media.plates[key] = `plates/${key}${extname(found).toLowerCase()}`;
      sources.push({ kind: "copy", from: found, to: media.plates[key] });
    }
    if (needLayers && !media.layers[key]) {
      const mattes = MATTES.map((m) => join(platesDir, `${key}.${m}.png`));
      if (!mattes.every(isFile)) return; // the plan names the missing mattes
      media.layers[key] = { far: media.plates[key], mid: `plates/${key}.mid.layer.png`, near: `plates/${key}.near.layer.png` };
      layers.push({ plate: found, matte: mattes[1], to: media.layers[key].mid });
      layers.push({ plate: found, matte: mattes[0], to: media.layers[key].near });
    }
  };
  let footageCount = 0;
  for (const shot of wanted) {
    const entry = edl[shot.id];
    if (!isObj(entry)) continue;
    if (Array.isArray(entry.segs)) {
      for (const seg of entry.segs.filter(isObj)) {
        if (typeof seg.plate === "string" && plateKey(shot.id, seg.plate)) addPlate(seg.plate, false);
        if (typeof seg.clip === "string") {
          const take = takeOf(seg.clip);
          if (!take || !KEY.test(take.clip)) {
            flag(shot.id, `--edl: ${shown(shot.id)} names take ${shown(seg.clip)}, which is not <clip>-t<n>`);
            continue;
          }
          const file = join(clipsDir, take.clip, `take-${take.n}.mp4`);
          if (!isFile(file)) continue; // the plan names the missing take
          media.clips[seg.clip] = `clips/${take.clip}/take-${take.n}.mp4`;
          sources.push({ kind: "copy", from: file, to: media.clips[seg.clip] });
        }
      }
    } else if (typeof entry.plate === "string") {
      if (plateKey(shot.id, entry.plate)) addPlate(entry.plate, shot.motion_tier === "plate3d");
    } else if (typeof entry.footage === "string") {
      const name = entry.footage;
      if (!realFootage) {
        flag(shot.id, `--footage: ${shown(shot.id)} plays footage ${shown(name)} and no --footage folder was given`);
        continue;
      }
      let real = "";
      try {
        real = realpathSync(join(realFootage, name));
      } catch {
        real = "";
      }
      if (/[/\\]/.test(name) || name === "." || name === ".." || (real !== "" && !real.startsWith(realFootage + sep))) {
        flag(shot.id, `--footage: ${shown(shot.id)} footage ${shown(name)} is outside the footage folder`);
        continue;
      }
      if (!real || !isFile(real)) continue; // the plan names the missing footage
      if (!media.footage[name]) {
        const ext = /^\.[A-Za-z0-9]{1,5}$/.test(extname(name)) ? extname(name).toLowerCase() : "";
        media.footage[name] = `footage/f${String(++footageCount).padStart(3, "0")}${ext}`;
        sources.push({ kind: "copy", from: real, to: media.footage[name] });
      }
    }
  }

  const ramp = !values["no-ramp"];
  const built = buildPlan({ chapter: chapterId, board: JSON.parse(boardText), edl, words, beats, hits, display, palette, media, ramp, vertical });
  // A shot already refused above is not refused again for the media it then lacks.
  const isMediaLine = (p: string) => /^--(plates|clips|footage):/.test(p);
  // The plan quotes board text with JSON.stringify: printed with every control escaped.
  problems.push(...built.problems.filter((p) => !(isMediaLine(p) && [...flagged].some((id) => p.includes(shown(id))))).map(printable));
  const out = fromCaller(v.out);
  const outIssue = outProblem(out);
  if (outIssue) problems.push(outIssue);
  if (problems.length > 0 || !built.plan) throw new Refused(problems);
  const plan = built.plan;

  // --range t0:t1 in song seconds, inside the chapter.
  const total = plan.to - plan.from;
  let frames: [number, number] = [0, total - 1];
  let range: [number, number] | null = null;
  if (v.range !== undefined) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v.range);
    const a = m ? Number(m[1]) : Number.NaN;
    const b = m ? Number(m[2]) : Number.NaN;
    if (!m || !(a < b)) throw new Refused([`--range is ${shown(v.range)}, want t0:t1 in song seconds (t0 before t1)`]);
    const fa = frameAt(a) - plan.from;
    const fb = frameAt(b) - plan.from - 1;
    if (fa < 0 || fb > total - 1 || fb < fa) throw new Refused([`--range ${shown(v.range)} is not inside chapter ${shown(chapterId)} (${plan.t0} to ${plan.t1} s)`]);
    frames = [fa, fb];
    range = [a, b];
  }

  const texts: Record<string, string> = {
    "in/board.json": boardText,
    "in/edl.json": JSON.stringify(edl),
    "in/words.json": JSON.stringify(words),
    "in/beats.json": JSON.stringify(beats),
    "in/hits.json": JSON.stringify(hits),
    "in/display.txt": display,
  };
  return {
    plan,
    values,
    inputs: { board: boardFile, edl: edlFile, words: wordsFile, beats: beatsFile, hits: hitsFile, display: displayFile, plates: platesDir, clips: clipsDir, footage: footageDir, brand: brandDir },
    out,
    chapter: chapterId,
    frames,
    range,
    sources,
    layers,
    texts,
    palette: readFileSync(paletteFile, "utf8"),
    fonts: join(brandDir, "fonts"),
    media,
  };
}

export type Stage = { dir: string; publicDir: string; propsFile: string; props: FilmProps; plan: Plan };

// Stages the render's public folder in temp: the inputs, the brand, the plates, the 2.5D layers
// (the plate with each matte as its alpha, through ffmpeg), the takes and the footage, and
// `in/media.json` with every video's length; then rebuilds the plan with those lengths (the
// same function, the same inputs the composition will read).
export async function stageChapter(p: Prepared, extra: Partial<FilmProps> = {}): Promise<Stage> {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-chapter-"));
  const publicDir = join(dir, "public");
  const put = (name: string, data: string | Buffer) => {
    const target = join(publicDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  };
  try {
    for (const [name, text] of Object.entries(p.texts)) put(name, text);
    put("brand/palette.json", p.palette);
    for (const f of FONT_FILES) put(`brand/fonts/${f.file}`, readFileSync(join(p.fonts, f.file)));
    for (const s of p.sources) {
      const target = join(publicDir, s.to);
      mkdirSync(dirname(target), { recursive: true });
      try {
        linkSync(s.from, target);
      } catch {
        copyFileSync(s.from, target);
      }
    }
    for (const l of p.layers) {
      const target = join(publicDir, l.to);
      mkdirSync(dirname(target), { recursive: true });
      const size = await probeVideo(l.plate);
      if (!size) throw new Refused([`--plates: ${shown(l.plate.split(sep).pop())} cannot be read as an image`]);
      await must(`making the 2.5D layer ${l.to}`, "ffmpeg", [
        "-y", "-loglevel", "error", "-i", l.plate, "-i", l.matte,
        "-filter_complex", `[1:v]scale=${size.width}:${size.height}:flags=bicubic,format=gray[a];[0:v]format=rgba[p];[p][a]alphamerge,format=rgba`,
        "-frames:v", "1", "-update", "1", target,
      ]);
    }
    const media: Media = { ...p.media, frames: {} };
    for (const src of [...Object.values(media.clips), ...Object.values(media.footage)]) {
      const probe = await probeVideo(join(publicDir, src));
      if (!probe || !Number.isFinite(probe.duration)) throw new Refused([`${shown(src)} cannot be read as a video`]);
      media.frames[src] = Math.max(1, Math.floor(probe.duration * 24 + 1e-6));
    }
    put("in/media.json", JSON.stringify(media));
    const props: FilmProps = {
      chapter: p.chapter,
      board: p.inputs.board as string,
      edl: p.inputs.edl as string,
      words: p.inputs.words as string,
      beats: p.inputs.beats as string,
      hits: p.inputs.hits as string,
      display: p.inputs.display as string,
      plates: p.inputs.plates as string,
      clips: p.inputs.clips as string,
      footage: p.inputs.footage,
      brand: p.inputs.brand as string,
      ramp: p.plan.ramp,
      vertical: p.plan.vertical,
      ...extra,
    };
    const propsFile = join(dir, "props.json");
    writeFileSync(propsFile, JSON.stringify(props));
    const rebuilt = buildPlan({
      chapter: p.chapter,
      board: JSON.parse(p.texts["in/board.json"]),
      edl: JSON.parse(p.texts["in/edl.json"]),
      words: JSON.parse(p.texts["in/words.json"]),
      beats: JSON.parse(p.texts["in/beats.json"]),
      hits: JSON.parse(p.texts["in/hits.json"]),
      display: p.texts["in/display.txt"],
      palette: JSON.parse(p.palette),
      media,
      ramp: p.plan.ramp,
      vertical: p.plan.vertical,
    });
    if (!rebuilt.plan) throw new Refused(rebuilt.problems.map(printable));
    return { dir, publicDir, propsFile, props, plan: rebuilt.plan };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
