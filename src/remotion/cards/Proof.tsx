import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The proof beat: one line, and beneath it the source it rests on, marked by a small green dot.
export function Proof({ line, source, look }: { line: string; source: string; look: Look }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const width = Math.min(1400 * t, look.width - 2 * margin);
  // Up to three balanced lines; the type steps down from 96 px to fit them, never below 72 px.
  const size = look.fit(line, 96 * t, 72 * t, width, 3);
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
        <h2
          style={{
            margin: 0,
            maxWidth: width,
            fontSize: size,
            fontWeight: 600,
            lineHeight: 1.06,
            letterSpacing: "-0.025em",
            color: color.warmWhite,
            ...look.wrap,
          }}
        >
          {line}
        </h2>
        <div style={{ display: "flex", alignItems: "flex-start", marginTop: 40 * t, maxWidth: width }}>
          <div
            style={{
              width: 12 * t,
              height: 12 * t,
              borderRadius: "50%",
              backgroundColor: color.productGreen,
              marginRight: 18 * t,
              // Centred on the first line of the source (36 px type, 1.3 line height).
              marginTop: ((36 * 1.3 - 12) / 2) * t,
              flexShrink: 0,
            }}
          />
          <div
            style={{
              fontSize: 36 * t,
              fontWeight: 400,
              lineHeight: 1.3,
              color: color.silver,
              opacity: 0.72,
              minWidth: 0,
              ...look.wrap,
            }}
          >
            {source}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}
