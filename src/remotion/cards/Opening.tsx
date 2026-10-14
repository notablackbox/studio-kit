import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The opening card: a short green rule, the headline and one supporting line, left on the grid.
export function Opening({ headline, sub, look }: { headline: string; sub: string; look: Look }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.black,
        justifyContent: "center",
        paddingLeft: margin,
        paddingRight: margin,
      }}
    >
      <div style={look.settle(frame)}>
        <div style={{ width: 56 * t, height: 4 * t, backgroundColor: color.productGreen, marginBottom: 44 * t }} />
        <h1
          style={{
            margin: 0,
            maxWidth: Math.min(1400 * t, look.width - 2 * margin),
            fontSize: 112 * t,
            fontWeight: 600,
            lineHeight: 1.04,
            letterSpacing: "-0.025em",
            color: color.warmWhite,
            textWrap: "balance",
          }}
        >
          {headline}
        </h1>
        <p
          style={{
            margin: 0,
            marginTop: 36 * t,
            fontSize: 40 * t,
            fontWeight: 400,
            lineHeight: 1.3,
            letterSpacing: "-0.005em",
            color: color.silver,
            opacity: 0.72,
            textWrap: "balance",
          }}
        >
          {sub}
        </p>
      </div>
    </AbsoluteFill>
  );
}
