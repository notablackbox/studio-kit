import { Refused, isMain, parseFlags, run, shown } from "./lib/cli.ts";
import { CHAPTER_FLAGS, type ChapterValues } from "./lib/chapter.ts";
import { renderChapter } from "./chapter.ts";

// film:reframe: the 9:16 cut of a chapter (or a `--range` of it): FilmChapterVertical at
// 1080x1920 over the same timeline, clips and plates fitted to the frame's width on the
// brand's black, type re-flowed beneath them, never cropped UI (toolkit item 25). It takes
// film:chapter's flags and `--aspect 9:16`, and writes `<chapter>.9x16.mp4` with its own tokens
// sidecar, so film:gate runs on the vertical cut too.

const COMMAND = "film:reframe";

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, { ...CHAPTER_FLAGS, aspect: { type: "string" } });
  const aspect = values.aspect ?? "9:16";
  if (aspect !== "9:16") throw new Refused([`--aspect is ${shown(aspect)}, want 9:16`]);
  return renderChapter(COMMAND, "reframe", values as ChapterValues, true);
}

if (isMain(import.meta.url)) run(COMMAND, main);
