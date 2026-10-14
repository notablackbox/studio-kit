import { interpolate, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

const SIZE = 48;
const LINE = 1.2;
const GAP = 48;
const MAX_LINES = 2;

// In 4:5 the caption hangs beneath the clip: this is the height it may add below the clip's
// edge (the gap and two lines, the most a 60 character caption takes), so the clip and its
// caption are centred as one block.
export const captionBelowHeight = (t: number) => (GAP + MAX_LINES * SIZE * LINE) * t;

// The caption. It is never cut: a caption too long for one line wraps to two balanced lines
// (a cut script's caption is at most 60 characters). In 16:9 it sits bottom left over the clip
// on a soft black band that grows with it; in 4:5 it sits on black beneath the clip, from
// `top` down. It fades in once the cross-fade is done.
export function LowerThird({ caption, look, top }: { caption: string; look: Look; top?: number }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const opacity = interpolate(frame, [12, 27], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const text = (
    <div
      style={{
        position: "relative",
        fontSize: SIZE * t,
        fontWeight: 400,
        lineHeight: LINE,
        letterSpacing: "-0.01em",
        color: color.warmWhite,
        textWrap: "balance",
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
