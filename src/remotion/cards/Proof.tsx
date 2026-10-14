import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The proof beat: one line, and beneath it the source it rests on, marked by a small green dot.
export function Proof({ line, source, look }: { line: string; source: string; look: Look }) {
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
        <h2
          style={{
            margin: 0,
            maxWidth: Math.min(1400 * t, look.width - 2 * margin),
            fontSize: 96 * t,
            fontWeight: 600,
            lineHeight: 1.06,
            letterSpacing: "-0.025em",
            color: color.warmWhite,
            textWrap: "balance",
          }}
        >
          {line}
        </h2>
        <div style={{ display: "flex", alignItems: "center", marginTop: 40 * t }}>
          <div
            style={{
              width: 12 * t,
              height: 12 * t,
              borderRadius: "50%",
              backgroundColor: color.productGreen,
              marginRight: 18 * t,
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
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {source}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}
