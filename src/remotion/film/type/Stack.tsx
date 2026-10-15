import type { FilmLook } from "../look.ts";
import type { DrawnBlock } from "../plan.ts";
import { Tokens } from "./Tokens.tsx";

// stack: short emphatic lines, one word to a row, each row bigger than the one above, so the
// object word (the last) is the biggest and the lowest. Hung from the left axis, low in the
// frame; 9:16: beneath the picture.
export function Stack({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const { margin } = look;
  const width = look.width - margin.l - margin.r;
  const all = block.text.trim().split(/\s+/).length;
  const base = look.vertical ? 1080 : look.height;
  const small = Math.round(base * 0.065);
  const big = Math.round(base * 0.14);
  const rows = block.tokens.map((tok, k) => {
    const want = all <= 1 ? big : Math.round(small + ((big - small) * k) / (all - 1));
    const size = look.fit(tok.text.toUpperCase(), "headline", want, Math.min(want, 56), width, 1);
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
