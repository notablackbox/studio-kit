import { fitText } from "../fit.ts";

// The frame's grid, the type sizes and the devices' heights, for 16:9 (1920x1080) and the 9:16
// reframe (1080x1920). No React: plan.ts checks with these that every card's type fits before
// a frame is drawn (a token the sidecar lists is never off-frame), and look.ts lays out with
// the same numbers. The craft defaults (spec 3.4, toolkit item 18): margins left 72, top 56,
// right 96, bottom 84 at 1920x1080; lyric type in the text face at 44 px, never under 36;
// full-frame headlines at 12 to 16 percent of the frame's height.

export type Box = { x: number; y: number; w: number; h: number };
export type Face = "headline" | "text" | "mono";

// The headline face is condensed: its letters take about 0.62 of the text face's advance.
export const ADVANCE: Record<Face, number> = { headline: 0.62, text: 1, mono: 1.05 };

export const fitFace = (text: string, face: Face, max: number, min: number, width: number, lines: number) => fitText(text, max, min, width / ADVANCE[face], lines);

export function geometry(vertical: boolean) {
  const width = vertical ? 1080 : 1920;
  const height = vertical ? 1920 : 1080;
  const margin = vertical ? { l: 72, t: 56, r: 72, b: 84 } : { l: 72, t: 56, r: 96, b: 84 };
  const ph = Math.round((width * 9) / 16);
  const py = vertical ? 700 : 0;
  const picture: Box = vertical ? { x: 0, y: py, w: width, h: ph } : { x: 0, y: 0, w: width, h: height };
  const base = vertical ? 1080 : height; // the 16:9 master's height sets the headline sizes
  return {
    width,
    height,
    vertical,
    margin,
    picture,
    below: py + ph + 56, // 9:16: where the type beneath the picture starts
    above: { x: margin.l, y: 150, w: width - margin.l - margin.r, h: py - 150 - 32 } as Box, // 9:16: the devices' band
    text: width - margin.l - margin.r,
    // The subtitle's band: 58 percent of the 16:9 frame's width (the text width in 9:16); its
    // type is set 44 px narrower (22 px of padding either side).
    subtitleBand: vertical ? width - margin.l - margin.r : Math.round(width * 0.58),
    sizes: {
      subtitle: { max: 44, min: 36, lines: 2 },
      coverline: { max: 88, min: 56, lines: vertical ? 2 : 1 },
      masthead: { max: Math.round(base * 0.16), min: Math.round(base * (vertical ? 0.09 : 0.12)), lines: 2 },
    },
  };
}

// A stack's row sizes: one word to a row, from 6.5 to 14 percent of the 16:9 master's height,
// each row bigger than the one above (`all` the block's words, `k` the row); a row steps down
// to fit the frame's width on one line, never under its floor (56 px, or `want` when smaller).
export function stackSize(vertical: boolean, height: number, all: number, k: number): { want: number; min: number } {
  const base = vertical ? 1080 : height;
  const small = Math.round(base * 0.065);
  const big = Math.round(base * 0.14);
  const want = all <= 1 ? big : Math.round(small + ((big - small) * k) / (all - 1));
  return { want, min: Math.min(want, 56) };
}

// A device's height at full size, estimated from its kind and params (panel padding, the mono
// line height); the 9:16 band steps a shot's devices down together when they need more.
export function deviceHeight(kind: string, params: Record<string, unknown>): number {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (kind) {
    case "counter":
      return 180;
    case "label":
      return 56;
    case "terminal":
      return 40 + 32 * Math.max(1, count(params.lines) || String(params.text ?? "").split("\n").length);
    case "chart":
      return 300;
    case "strike":
      return 116;
    default:
      return 76 + 44 * count(params.rows);
  }
}

export const DEVICE_GAP = 20;
export const MIN_DEVICE_SCALE = 0.6;
