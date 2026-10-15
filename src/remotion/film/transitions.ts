import type { CSSProperties } from "react";
import { ditherPath } from "./plan.ts";

// The two transitions of R4. `cut` needs nothing: the incoming shot is simply drawn. `dither`
// runs twelve frames: the incoming picture shows through an ordered-dither (8x8 Bayer) clip of
// 24 px cells whose share grows with progress, over the outgoing picture still playing; each
// cell switches once and never back, so the wipe cannot flicker, and the frame's mean light
// moves over the twelve frames rather than at once.

export const DITHER_CELL = 24;

export function ditherClip(width: number, height: number, progress: number): CSSProperties {
  return { clipPath: `path('${ditherPath(width, height, DITHER_CELL, progress)}')` };
}
