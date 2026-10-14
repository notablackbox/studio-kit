import { linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";

// The film's one transition: a cross-fade, linear, no slide. Its length is CROSSFADE_FRAMES
// (12), exported from Teaser.tsx with the card lengths so the render's sum and the
// composition read one set of numbers.
export function crossFade(durationInFrames: number) {
  return { presentation: fade(), timing: linearTiming({ durationInFrames }) };
}
