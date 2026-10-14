import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import type { Look } from "../Teaser.tsx";

// The brand files, shown as they are: never redrawn.
const MARK = new URL("../../../brand/mark.svg", import.meta.url).href;
const WORDMARK = new URL("../../../brand/wordmark-dark.svg", import.meta.url).href;

// The stacked lockup, nabb-fe public/icons/brand/nabb-logo-stacked-dark.svg: a 231.85 by 226
// box, the mark (156.32 by 100) top left, the wordmark (231.85 by 100) below it at y 126,
// both left aligned, so the gap between them is 26.
const LOCKUP = { width: 231.85, markWidth: 156.32, markHeight: 100, wordmarkHeight: 100, wordmarkTop: 126 };

// The closing card: the lockup, the closing line and the date.
export function Closing({ line, date, look }: { line: string; date: string; look: Look }) {
  const frame = useCurrentFrame();
  const { t, margin, color } = look;
  const s = (300 * t) / LOCKUP.width;
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
        <div style={{ position: "relative", width: LOCKUP.width * s, height: (LOCKUP.wordmarkTop + LOCKUP.wordmarkHeight) * s }}>
          <Img
            src={MARK}
            style={{ position: "absolute", left: 0, top: 0, width: LOCKUP.markWidth * s, height: LOCKUP.markHeight * s }}
          />
          <Img
            src={WORDMARK}
            style={{
              position: "absolute",
              left: 0,
              top: LOCKUP.wordmarkTop * s,
              width: LOCKUP.width * s,
              height: LOCKUP.wordmarkHeight * s,
            }}
          />
        </div>
        <h2
          style={{
            margin: 0,
            marginTop: 88 * t,
            maxWidth: Math.min(1400 * t, look.width - 2 * margin),
            fontSize: 72 * t,
            fontWeight: 600,
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            color: color.warmWhite,
            textWrap: "balance",
          }}
        >
          {line}
        </h2>
        <p
          style={{
            margin: 0,
            marginTop: 24 * t,
            fontSize: 36 * t,
            fontWeight: 400,
            lineHeight: 1.3,
            color: color.silver,
            opacity: 0.72,
          }}
        >
          {date}
        </p>
      </div>
    </AbsoluteFill>
  );
}
