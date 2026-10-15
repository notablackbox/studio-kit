import { rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT, Unexpected, isMain, parseFlags, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { CHAPTER_FLAGS, prepareChapter, stageChapter, type ChapterValues } from "./lib/chapter.ts";
import { ENTRY, probeVideo, remotion } from "./lib/media.ts";
import { audioEvents, tokensSidecar } from "../remotion/film/plan.ts";

// film:chapter: one chapter of the film, rendered straight to video by Remotion over headless
// Chromium (toolkit item 18; D7; R5). FilmChapter draws it from the board, the edit list, the
// analysis, the plates, the takes, the footage and the brand; `--range t0:t1` (song seconds)
// renders part of it; `--vertical` renders FilmChapterVertical (as film:reframe does). Writes
// `<chapter>.mp4` (or `<chapter>.9x16.mp4`), the tokens sidecar `<chapter>.tokens.json` (R1:
// for every frame rendered, the display tokens drawn with their word indices) and the sound
// events `<chapter>.audio.json` (`[{t, kind, gain}]` for film:mix), both from the same
// frameState the composition draws with, plus the report with ffprobe's measure of the video.

const COMMAND = "film:chapter";

export async function renderChapter(command: string, report: string, values: ChapterValues, vertical: boolean): Promise<number> {
  const prepared = prepareChapter(command, values, { vertical, report });
  const { out, chapter } = prepared;
  const suffix = vertical ? ".9x16" : "";
  const names = { video: `${chapter}${suffix}.mp4`, tokens: `${chapter}${suffix}.tokens.json`, audio: `${chapter}${suffix}.audio.json` };
  const started = Date.now();
  const stage = await stageChapter(prepared);
  try {
    const [a, b] = prepared.frames;
    const composition = vertical ? "FilmChapterVertical" : "FilmChapter";
    rmSync(join(out, names.video), { force: true });
    await remotion(`rendering ${composition}`, [
      "render", ENTRY, composition, join(out, names.video),
      `--props=${stage.propsFile}`, `--public-dir=${stage.publicDir}`,
      "--codec=h264", "--color-space=bt709", `--frames=${a}-${b}`,
    ]);
    const probe = await probeVideo(join(out, names.video));
    if (!probe) throw new Unexpected(`${names.video} cannot be read back`);
    const want = vertical ? [1080, 1920] : [1920, 1080];
    if (probe.width !== want[0] || probe.height !== want[1]) throw new Unexpected(`${names.video} measures ${probe.width}x${probe.height}, want ${want[0]}x${want[1]}`);
    if (probe.fps !== 24) throw new Unexpected(`${names.video} runs at ${probe.fps} fps, want 24`);

    const plan = stage.plan;
    const sidecar = tokensSidecar(plan, a, b);
    const t0 = (plan.from + a) / plan.fps;
    const t1 = (plan.from + b + 1) / plan.fps;
    const events = audioEvents(plan, t0, t1).map(({ t, kind, gain, shot, what }) => ({ t, kind, gain, shot, what }));
    writeIn(out, names.tokens, JSON.stringify(sidecar) + "\n");
    writeIn(out, names.audio, JSON.stringify(events, null, 2) + "\n");
    const drawn = new Set(sidecar.frames.flatMap((f) => f.tokens.map((t) => t.word)));
    const frames = b - a + 1;
    writeReport(out, report, {
      ok: true,
      inputs: { ...prepared.inputs, chapter, range: prepared.range, vertical },
      // false only under the test-only --no-ramp: film:encode refuses such a chapter.
      ramp: plan.ramp,
      outputs: { video: names.video, tokens: names.tokens, audio: names.audio, report: `${report}-report.json` },
      chapter: { id: chapter, t0: plan.t0, t1: plan.t1, frames: plan.to - plan.from },
      rendered: { frames, first: a, last: b, t0: Math.round(t0 * 10000) / 10000, t1: Math.round(t1 * 10000) / 10000 },
      video: { duration: probe.duration, size: probe.size, width: probe.width, height: probe.height, fps: probe.fps, codec: probe.codec, color_primaries: probe.color_primaries, color_transfer: probe.color_transfer, color_space: probe.color_space },
      shots: plan.shots.filter((s) => s.to > plan.from + a && s.from <= plan.from + b).map((s) => s.id),
      words_drawn: drawn.size,
      events: events.length,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    });
    console.log(`${command.replace("film:", "")}: ${shown(chapter)} ${frames} frames (${probe.duration.toFixed(3)} s, ${probe.width}x${probe.height}, ${probe.fps} fps, ${probe.size} bytes), ${drawn.size} sung words drawn, ${events.length} sound events`);
    return EXIT.done;
  } catch (error) {
    rmSync(join(out, names.video), { force: true });
    throw error;
  } finally {
    rmSync(stage.dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { ...CHAPTER_FLAGS, vertical: { type: "boolean" } });
  return renderChapter(COMMAND, "chapter", values as ChapterValues, values.vertical === true);
}

if (isMain(import.meta.url)) run(COMMAND, main);
