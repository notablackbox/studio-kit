import { interpolate, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

const SIZE = 48;
const MIN_SIZE = 32;
const LINE = 1.2;
const GAP = 48;
const MAX_LINES = 2;

// The caption's size: 48 px, stepped down (never below 32 px) until it fits two lines across
// the margins, so a caption of wide glyphs (W, CJK) still takes the two lines reserved for it.
function captionFit(caption: string, look: Look): { size: number; lines: number } {
  return look.fitText(caption, SIZE * look.t, MIN_SIZE * look.t, look.width - 2 * look.margin, MAX_LINES);
}

// In 4:5 the caption hangs beneath the clip: this is the height it adds below the clip's edge
// (the gap and two lines at 48 px; more only if a caption could not fit two lines at 32 px),
// so the clip and its caption are centred as one block, the same for every clip.
export function captionBelowHeight(caption: string, look: Look): number {
  const { size, lines } = captionFit(caption, look);
  return GAP * look.t + Math.max(MAX_LINES * SIZE * look.t, lines * size) * LINE;
}

// The caption. It is never cut: a caption too long for one line wraps to two balanced lines
// (a cut script's caption is at most 60 characters). In 16:9 it sits bottom left over the clip
// on a soft black band that grows with it; in 4:5 it sits on black beneath the clip, from
// `top` down. It fades in once the cross-fade is done.
export function LowerThird({ caption, look, top }: { caption: string; look: Look; top?: number }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const opacity = interpolate(frame, [12, 27], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const { size } = captionFit(caption, look);
  const text = (
    <div
      style={{
        position: "relative",
        fontSize: size,
        fontWeight: 400,
        lineHeight: LINE,
        letterSpacing: "-0.01em",
        color: color.warmWhite,
        ...look.wrap,
      }}
    >
      {caption}
    </div>
  );

  if (top !== undefined) {
    return (
      <div style={{ position: "absolute", left: margin, right: margin, top: top + GAP * t, opacity }}>{text}</div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        minHeight: 152 * t,
        boxSizing: "border-box",
        padding: `${28 * t}px ${margin}px`,
        display: "flex",
        alignItems: "center",
        opacity,
      }}
    >
      <div style={{ position: "absolute", inset: 0, backgroundColor: color.black, opacity: 0.65 }} />
      {text}
    </div>
  );
}
