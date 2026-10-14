import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The opening card: a short green rule, the headline and one supporting line, left on the grid.
export function Opening({ headline, sub, look }: { headline: string; sub: string; look: Look }) {
  const frame = useCurrentFrame();
  const { u, margin, color } = look;
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
        <div style={{ width: 56 * u, height: 4 * u, backgroundColor: color.productGreen, marginBottom: 44 * u }} />
        <h1
          style={{
            margin: 0,
            maxWidth: 1400 * u,
            fontSize: 112 * u,
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
            marginTop: 36 * u,
            fontSize: 40 * u,
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
