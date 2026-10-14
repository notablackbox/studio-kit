import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The opening card: a short green rule, the headline and one supporting line, left on the grid.
export function Opening({ headline, sub, look }: { headline: string; sub: string; look: Look }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const width = Math.min(1400 * t, look.width - 2 * margin);
  // A long headline (at most 60 characters) takes up to three balanced lines; the type steps
  // down from 112 px to fit them, and never below 72 px.
  const size = look.fit(headline, 112 * t, 72 * t, width, 3);
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
            maxWidth: width,
            fontSize: size,
            fontWeight: 600,
            lineHeight: 1.04,
            letterSpacing: "-0.025em",
            color: color.warmWhite,
            ...look.wrap,
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
            ...look.wrap,
          }}
        >
          {sub}
        </p>
      </div>
    </AbsoluteFill>
  );
}
