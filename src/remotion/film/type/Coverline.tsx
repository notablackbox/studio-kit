import type { FilmLook } from "../look.ts";
import { plainText, type DrawnBlock } from "../plan.ts";
import { Tokens } from "./Tokens.tsx";

// coverline: one line, large, hung from the left axis in the plate's empty field, tracking
// collapsing word by word as it lands. 9:16: beneath the picture, two lines at most.
export function Coverline({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const { margin } = look;
  const width = look.width - margin.l - margin.r;
  const { max, min, lines } = look.sizes.coverline;
  const size = look.fit(plainText(block.text), "text", max, min, width, lines);
  const style = {
    fontFamily: `"${look.face.text}", sans-serif`,
    fontWeight: 600,
    fontSize: size,
    lineHeight: 1.05,
    letterSpacing: "-0.02em",
    textShadow: look.shadow,
    whiteSpace: look.vertical ? ("normal" as const) : ("nowrap" as const),
  };
  if (look.vertical) {
    return (
      <div style={{ position: "absolute", left: margin.l, top: look.below, width, ...style }}>
        <Tokens tokens={block.tokens} look={look} />
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", left: margin.l, top: "50%", transform: "translateY(-50%)", maxWidth: width, ...style }}>
      <Tokens tokens={block.tokens} look={look} />
    </div>
  );
}
