import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, KIT_ROOT, Refused, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { RENDER_TIMEOUT, moveIn, must, probeVideo } from "./lib/media.ts";
import { lyricLines, parseTokens, plainText, readPalette } from "../remotion/film/plan.ts";

// film:captions: the captions (spec 6). `captions.srt` holds one cue per display line: the
// line's display text with the token markers stripped, from its first sung word's start to its
// last word's end (words.json). With --video, `captioned.mp4` is that video with the SRT
// burned in by ffmpeg's subtitles filter in the text face (Inter), bottom left, in the brand's
// warm white outlined in its black (palette.json). The cues are song time, so --video must be
// the full master (or anything that starts at the song's first sample), not a chapter.

const COMMAND = "film:captions";

const stamp = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { words: { type: "string" }, display: { type: "string" }, video: { type: "string" }, brand: { type: "string" }, out: { type: "string" } });
  if (!values.words || !values.display || !values.out) throw new Refused([`${COMMAND}: --words, --display and --out are required`]);
  const wordsFile = requireFile(fromCaller(values.words), "--words");
  const displayFile = requireFile(fromCaller(values.display), "--display");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(wordsFile, "utf8"));
  } catch {
    throw new Refused(["--words is not a words.json"]);
  }
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { words?: unknown }).words) ? ((raw as { words: unknown[] }).words as Record<string, unknown>[]) : null;
  if (!list || !list.every((w) => typeof w === "object" && w !== null && typeof w.t0 === "number" && typeof w.t1 === "number" && Number.isInteger(w.line))) throw new Refused(["--words is not a words.json"]);
  const words = list.map((w) => ({ line: w.line as number, t0: w.t0 as number, t1: w.t1 as number }));
  const display = lyricLines(readFileSync(displayFile, "utf8"));
  const lineCount = new Set(words.map((w) => w.line)).size;
  const problems: string[] = [];
  if (display.length !== lineCount) problems.push(`--display has ${display.length} lyric line${display.length === 1 ? "" : "s"}, words.json has ${lineCount}`);
  else
    display.forEach((text, n) => {
      const want = words.filter((w) => w.line === n).length;
      const got = parseTokens(text).reduce((s, t) => s + t.count, 0);
      if (got !== want) problems.push(`--display line ${n} (${shown(text)}) shows ${got} sung words, words.json has ${want}`);
    });
  const video = values.video ? requireFile(fromCaller(values.video), "--video") : null;
  if (video && !(await probeVideo(video))) problems.push("--video cannot be read as a video");
  const brand = values.brand ? fromCaller(values.brand) : join(KIT_ROOT, "brand");
  const fonts = join(brand, "fonts");
  let colours: { white: string; black: string } | null = null;
  if (video) {
    try {
      colours = readPalette(JSON.parse(readFileSync(join(brand, "palette.json"), "utf8"))).palette;
    } catch {
      colours = null;
    }
    if (!colours) problems.push("--brand has no palette.json with black and warmWhite");
  }
  if (video) {
    try {
      if (!statSync(fonts).isDirectory()) throw new Error();
    } catch {
      problems.push("--brand has no fonts folder");
    }
  }
  const out = fromCaller(values.out);
  const issue = outProblem(out);
  if (issue) problems.push(issue);
  if (problems.length > 0) throw new Refused(problems);

  const cues = display.flatMap((text, n) => {
    const sung = words.filter((w) => w.line === n);
    if (sung.length === 0) return [];
    return [{ line: n, t0: Math.min(...sung.map((w) => w.t0)), t1: Math.max(...sung.map((w) => w.t1)), text: plainText(text) }];
  });
  const srt = cues.map((c, k) => `${k + 1}\n${stamp(c.t0)} --> ${stamp(c.t1)}\n${c.text}\n`).join("\n");
  writeIn(out, "captions.srt", srt);
  const outputs: Record<string, string> = { srt: "captions.srt", report: "captions-report.json" };
  let burned: Record<string, unknown> | null = null;
  if (video) {
    // The filter's arguments are paths inside a filter graph: work from a temp folder with plain names.
    const temp = mkdtempSync(join(tmpdir(), "studio-kit-captions-"));
    try {
      copyFileSync(join(out, "captions.srt"), join(temp, "captions.srt"));
      const fontDir = join(temp, "fonts");
      mkdirSync(fontDir);
      for (const f of readdirSync(fonts).filter((f) => /^Inter-.*\.(ttf|otf|woff2?)$/i.test(f))) copyFileSync(join(fonts, f), join(fontDir, f));
      // ASS colours are &HAABBGGRR.
      const ass = (hex: string) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
      const palette = colours as { white: string; black: string };
      const style = `FontName=Inter,FontSize=12,PrimaryColour=${ass(palette.white)},OutlineColour=${ass(palette.black)},BorderStyle=1,Outline=1,Shadow=0,Alignment=1,MarginL=20,MarginV=22`;
      await must("burning in the captions", "ffmpeg", [
        "-y", "-loglevel", "error", "-i", video,
        "-vf", `subtitles=filename=captions.srt:fontsdir=fonts:force_style='${style}'`,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", "captioned.mp4",
      ], RENDER_TIMEOUT, temp);
      const p = await probeVideo(join(temp, "captioned.mp4"));
      moveIn(out, "captioned.mp4", join(temp, "captioned.mp4"));
      outputs.captioned = "captioned.mp4";
      burned = p ? { duration: p.duration, size: p.size, width: p.width, height: p.height, fps: p.fps } : null;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  writeReport(out, "captions", { ok: true, inputs: { words: wordsFile, display: displayFile, video, brand: video ? brand : null }, outputs, cues, captioned: burned });
  console.log(`captions: ${cues.length} cue${cues.length === 1 ? "" : "s"} in captions.srt${video ? ", burned into captioned.mp4" : ""}`);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
