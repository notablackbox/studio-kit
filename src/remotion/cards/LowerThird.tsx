import { interpolate, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

const SIZE = 48;
const LINE = 1.2;
const GAP = 48;

// In 4:5 the caption hangs beneath the clip: this is the height it adds below the clip's edge,
// so the clip and its caption can be centred as one block.
export const captionBelowHeight = (t: number) => (GAP + SIZE * LINE) * t;

// One caption line. In 16:9 it sits bottom left over the clip on a soft black band; in 4:5
// it sits on black beneath the clip, from `top` down. It fades in once the cross-fade is done.
export function LowerThird({ caption, look, top }: { caption: string; look: Look; top?: number }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const opacity = interpolate(frame, [12, 27], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const text = (
    <div
      style={{
        fontSize: SIZE * t,
        fontWeight: 400,
        lineHeight: LINE,
        letterSpacing: "-0.01em",
        color: color.warmWhite,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
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

  const band = 152 * t;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: band, opacity }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: color.black, opacity: 0.65 }} />
      <div
        style={{
          position: "absolute",
          left: margin,
          right: margin,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        {text}
      </div>
    </div>
  );
}
