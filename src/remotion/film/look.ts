import type { CSSProperties } from "react";
import { FACE } from "./fonts.ts";
import { fitFace, geometry, type Box, type Face } from "./geometry.ts";
import type { Palette } from "./plan.ts";

// The frame's grid (geometry.ts) with the brand's colours and faces, for 16:9 and the 9:16
// reframe. In 9:16 the picture fits the frame's width on the brand's black, the devices sit
// above it and the type re-flows beneath it, at the master's pixel sizes stepped down to a
// floor (the 4:5 rule of TeaserSocial). Nothing is cropped.

export type { Box };
export type FilmLook = ReturnType<typeof geometry> & {
  color: Palette;
  face: typeof FACE;
  fit: (text: string, face: Face, max: number, min: number, width: number, lines: number) => number;
  shadow: string;
};

export function filmLook(width: number, height: number, color: Palette): FilmLook {
  return {
    ...geometry(height > width),
    color,
    face: FACE,
    fit: (text, face, max, min, w, lines) => fitFace(text, face, max, min, w, lines).size,
    shadow: `0 0 28px ${color.black}99`,
  };
}

export const abs = (box: Box): CSSProperties => ({ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, overflow: "hidden" });
