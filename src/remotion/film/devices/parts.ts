import type { CSSProperties } from "react";
import type { FilmLook } from "../look.ts";
import type { DrawnDevice } from "../plan.ts";

export type DeviceProps = { device: DrawnDevice; look: FilmLook };

// A device's colour for its one accented part: the accent when frameState granted it, else
// silver (the accent budget: at most two accented elements a frame).
export const accentOf = (d: DrawnDevice, look: FilmLook) => (d.accent ? look.color.accent : look.color.silver);

// An entrance takes at most an eighth of a beat: a stamp from 112 percent, settled by frame 2.
export const stamp = (age: number): CSSProperties => ({ transform: `scale(${age <= 0 ? 1.12 : age === 1 ? 1.05 : 1})`, transformOrigin: "left top" });

export const mono = (look: FilmLook, size: number, weight = 400): CSSProperties => ({
  fontFamily: `"${look.face.mono}", monospace`,
  fontSize: size,
  fontWeight: weight,
  letterSpacing: "0.04em",
  lineHeight: 1.3,
});

export const panel = (look: FilmLook): CSSProperties => ({ backgroundColor: `${look.color.black}c7`, padding: "16px 20px", boxSizing: "border-box" });

export const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
export const numberOf = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
