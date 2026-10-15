import { stackSize } from "../geometry.ts";
import type { FilmLook } from "../look.ts";
import type { DrawnBlock } from "../plan.ts";
import { Tokens } from "./Tokens.tsx";

// stack: short emphatic lines, one word to a row, each row bigger than the one above, so the
// object word (the last) is the biggest and the lowest. Hung from the left axis, low in the
// frame; 9:16: beneath the picture. plan.ts refuses a row that does not fit at its floor.
export function Stack({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const { margin } = look;
  const width = look.width - margin.l - margin.r;
  const all = block.text.trim().split(/\s+/).length;
  const rows = block.tokens.map((tok, k) => {
    const { want, min } = stackSize(look.vertical, look.height, all, k);
    const size = look.fit(tok.text.toUpperCase(), "headline", want, min, width, 1);
    return (
      <div key={k} style={{ fontSize: size, lineHeight: 0.98 }}>
        <Tokens tokens={[tok]} look={look} upper />
      </div>
    );
  });
  const place = look.vertical ? { top: look.below } : { bottom: margin.b + 24 };
  return (
    <div style={{ position: "absolute", left: margin.l, width, ...place, fontFamily: `"${look.face.headline}", sans-serif`, textShadow: look.shadow }}>
      {rows}
    </div>
  );
}
