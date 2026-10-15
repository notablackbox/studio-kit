import type { FilmLook } from "../look.ts";
import { plainText, type DrawnBlock } from "../plan.ts";
import { Tokens } from "./Tokens.tsx";

// masthead: the full-frame headline card, white on the brand's black (the card is drawn by the
// chapter under it), in the headline face at 12 to 16 percent of the frame height, each word
// landing in three frames. 9:16: the master's size stepped down to fit two lines.
export function Masthead({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const { margin } = look;
  const width = look.width - margin.l - margin.r;
  const text = plainText(block.text).toUpperCase();
  const { max, min, lines } = look.sizes.masthead;
  const size = look.fit(text, "headline", max, min, width, lines);
  return (
    <div
      style={{
        position: "absolute",
        left: margin.l,
        top: "50%",
        transform: "translateY(-50%)",
        width,
        fontFamily: `"${look.face.headline}", sans-serif`,
        fontSize: size,
        lineHeight: 1.0,
        letterSpacing: "0.005em",
        textWrap: "balance",
      }}
    >
      <Tokens tokens={block.tokens} look={look} upper />
    </div>
  );
}
