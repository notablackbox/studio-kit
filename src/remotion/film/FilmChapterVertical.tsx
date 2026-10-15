import { FilmChapter, type FilmProps } from "./FilmChapter.tsx";

// FilmChapterVertical (R5): the same chapter, the same timeline and the same frameState, at
// 1080x1920. The look (look.ts) fits clips and plates to the frame's width on the brand's
// black, stacks the devices above the picture and re-flows the type beneath it; full-frame
// cards stay full-frame. Nothing is cropped.
export function FilmChapterVertical(props: FilmProps) {
  return <FilmChapter {...props} />;
}
