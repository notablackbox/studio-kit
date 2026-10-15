import type { FilmLook } from "../look.ts";
import { plainText, type DrawnBlock } from "../plan.ts";
import { Masthead } from "./Masthead.tsx";

// mass: a declared wall of the word on the full black card, in the mono face in graphite (a
// texture, not a read), with the sung line still drawn over it as a masthead.
export function Mass({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  const word = plainText(block.text).toUpperCase().replace(/\s+/g, " ").trim() || "-";
  const size = 22;
  const rows = Math.ceil(look.height / (size * 1.25)) + 1;
  const perRow = Math.ceil(look.width / (size * 0.6)) + word.length + 2;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const shift = (r * 7) % (word.length + 1);
    lines.push(`${word} `.repeat(Math.ceil(perRow / (word.length + 1)) + 1).slice(shift, shift + perRow));
  }
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          fontFamily: `"${look.face.mono}", monospace`,
          fontSize: size,
          lineHeight: 1.25,
          color: look.color.graphite,
          whiteSpace: "pre",
          overflow: "hidden",
        }}
      >
        {lines.join("\n")}
      </div>
      <Masthead block={block} look={look} />
    </>
  );
}
