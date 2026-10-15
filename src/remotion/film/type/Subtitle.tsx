import type { FilmLook } from "../look.ts";
import { plainText, type DrawnBlock } from "../plan.ts";
import { Tokens } from "./Tokens.tsx";

// subtitle: the sung line on an in-scene band, bottom left, in the text face at 44 px (stepped
// down to 36 to fit two lines), the sung word lit in the accent. The band is sized from the
// whole line on the block's first frame and does not move or grow as words arrive. 9:16:
// beneath the picture. plan.ts refuses a line that takes more than two lines at 36 px.
export function Subtitle({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const { margin } = look;
  const width = look.subtitleBand;
  const { max, min, lines } = look.sizes.subtitle;
  const size = look.fit(plainText(block.text), "text", max, min, width - 44, lines);
  const text = (
    <div style={{ fontFamily: `"${look.face.text}", sans-serif`, fontWeight: 600, fontSize: size, lineHeight: 1.2, letterSpacing: "-0.01em", textWrap: "balance", overflowWrap: "anywhere" }}>
      <Tokens tokens={block.tokens} look={look} />
    </div>
  );
  if (look.vertical) {
    return <div style={{ position: "absolute", left: margin.l, top: look.below, width }}>{text}</div>;
  }
  return (
    <div style={{ position: "absolute", left: margin.l, bottom: margin.b, maxWidth: width, padding: "14px 22px 16px", boxSizing: "border-box" }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: look.color.black, opacity: 0.62 }} />
      <div style={{ position: "relative" }}>{text}</div>
    </div>
  );
}
