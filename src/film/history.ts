import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT, Failed, Refused, Unexpected, isMain, parseFlags, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { CHAPTER_FLAGS, prepareChapter, stageChapter, type ChapterValues } from "./lib/chapter.ts";
import { ENTRY, TOOL_TIMEOUT, must, remotion } from "./lib/media.ts";

// film:history: the history check (toolkit item 20; R2). Frame B is rendered alone with
// `npx remotion still`; then FilmHistory renders frame A and then frame B in one page (one tab,
// in order), and the two B frames are compared pixel by pixel (decoded to raw RGB by ffmpeg).
// Any channel that differs by more than 40 levels fails: the frame depended on what was drawn
// before it. Prints HISTORY-INDEPENDENT, or exit 3 with the differing pixels. The flags are
// film:chapter's (without --range) and `--frames A,B` (the chapter's frames, from 0).

const COMMAND = "film:history";
const LIMIT = 40;

async function rgb(file: string, out: string): Promise<Buffer> {
  await must(`decoding ${file.split("/").pop()}`, "ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", out], TOOL_TIMEOUT);
  return readFileSync(out);
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { ...CHAPTER_FLAGS, frames: { type: "string" } });
  if (values.range !== undefined) throw new Refused([`${COMMAND}: --range is not used here; name the two frames with --frames A,B`]);
  const prepared = prepareChapter(COMMAND, values as ChapterValues, ["frames"]);
  const m = /^(\d+),(\d+)$/.exec(values.frames ?? "");
  const total = prepared.plan.to - prepared.plan.from;
  if (!m) throw new Refused([`--frames is ${shown(values.frames)}, want A,B (two frames of the chapter)`]);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a >= total || b >= total) throw new Refused([`--frames ${shown(values.frames)}: chapter ${shown(prepared.chapter)} has frames 0 to ${total - 1}`]);
  if (a === b) throw new Refused([`--frames ${shown(values.frames)}: A and B must differ`]);

  const { out } = prepared;
  const stage = await stageChapter(prepared, { history: [a, b] });
  try {
    const alone = join(stage.dir, "b-alone.png");
    const seq = join(stage.dir, "a-then-b");
    const chapterProps = join(stage.dir, "chapter-props.json");
    writeIn(stage.dir, "chapter-props.json", JSON.stringify({ ...stage.props, history: null }));
    const common = [`--public-dir=${stage.publicDir}`];
    await remotion("rendering frame B alone", ["still", ENTRY, "FilmChapter", alone, `--props=${chapterProps}`, `--frame=${b}`, "--image-format=png", ...common], TOOL_TIMEOUT * 2);
    await remotion("rendering frames A then B in one page", ["render", ENTRY, "FilmHistory", seq, `--props=${stage.propsFile}`, "--sequence", "--image-format=png", "--concurrency=1", "--frames=0-1", ...common], TOOL_TIMEOUT * 2);
    const made = readdirSync(seq).filter((f) => f.endsWith(".png")).sort();
    if (made.length !== 2) throw new Unexpected(`FilmHistory rendered ${made.length} frames, want 2`);
    const after = join(seq, made[1]);
    const one = await rgb(alone, join(stage.dir, "alone.rgb"));
    const two = await rgb(after, join(stage.dir, "after.rgb"));
    if (one.length !== two.length || one.length === 0) throw new Unexpected("the two renders of frame B differ in size");
    const width = 1920;
    let worst = 0;
    let at = -1;
    let over = 0;
    for (let k = 0; k < one.length; k++) {
      const d = Math.abs(one[k] - two[k]);
      if (d > worst) {
        worst = d;
        at = k;
      }
      if (d > LIMIT) over++;
    }
    const pixel = at >= 0 ? Math.floor(at / 3) : -1;
    const where = pixel >= 0 ? { x: pixel % width, y: Math.floor(pixel / width) } : null;
    writeIn(out, `history-${b}.png`, readFileSync(alone));
    writeIn(out, `history-${a}-then-${b}.png`, readFileSync(after));
    const ok = worst <= LIMIT;
    writeReport(out, "history", {
      ok,
      inputs: { ...prepared.inputs, chapter: prepared.chapter, frames: [a, b] },
      outputs: { alone: `history-${b}.png`, after: `history-${a}-then-${b}.png`, report: "history-report.json" },
      limit: LIMIT,
      max_difference: worst,
      at: where,
      channels_over: over,
    });
    if (!ok) throw new Failed([`history: frame ${b} differs by ${worst} levels at ${where?.x},${where?.y} after frame ${a} (${over} channels over ${LIMIT})`]);
    console.log("HISTORY-INDEPENDENT");
    console.log(`history: frame ${b} alone and after frame ${a} differ by at most ${worst} levels`);
    return EXIT.done;
  } finally {
    rmSync(stage.dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
