import type { CSSProperties } from "react";
import { fitText } from "../Teaser.tsx";
import { FACE } from "./fonts.ts";
import type { Palette } from "./plan.ts";

// The frame's grid and the brand's colours, for 16:9 (1920x1080) and the 9:16 reframe
// (1080x1920). The craft defaults (spec 3.4, toolkit item 18): margins left 72, top 56, right
// 96, bottom 84 at 1920x1080; lyric type in the text face at 44 px (never under 36); full-frame
// headlines in the headline face at 12 to 16 percent of the frame height; chrome in the mono
// face. In 9:16 the picture fits the frame's width on the brand's black, the devices sit above
// it and the type re-flows beneath it, at the master's pixel sizes stepped down to a floor to
// fit two lines (the 4:5 rule of TeaserSocial). Nothing is cropped.

export type Box = { x: number; y: number; w: number; h: number };
export type FilmLook = {
  width: number;
  height: number;
  vertical: boolean;
  margin: { l: number; t: number; r: number; b: number };
  picture: Box;
  below: number; // 9:16: where the type beneath the picture starts
  above: Box; // 9:16: the band above the picture the devices stack in
  color: Palette;
  face: typeof FACE;
  fit: (text: string, face: "headline" | "text" | "mono", max: number, min: number, width: number, lines: number) => number;
  shadow: string;
};

// The headline face is condensed: its letters take about 0.62 of the text face's advance.
const ADVANCE = { headline: 0.62, text: 1, mono: 1.05 } as const;

export function filmLook(width: number, height: number, color: Palette): FilmLook {
  const vertical = height > width;
  const margin = vertical ? { l: 72, t: 56, r: 72, b: 84 } : { l: 72, t: 56, r: 96, b: 84 };
  const ph = Math.round((width * 9) / 16);
  const py = vertical ? 700 : 0;
  const picture = vertical ? { x: 0, y: py, w: width, h: ph } : { x: 0, y: 0, w: width, h: height };
  return {
    width,
    height,
    vertical,
    margin,
    picture,
    below: py + ph + 56,
    above: { x: margin.l, y: 150, w: width - margin.l - margin.r, h: py - 150 - 32 },
    color,
    face: FACE,
    fit: (text, face, max, min, w, lines) => fitText(text, max, min, w / ADVANCE[face], lines).size,
    shadow: `0 0 28px ${color.black}99`,
  };
}

export const abs = (box: Box): CSSProperties => ({ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, overflow: "hidden" });
