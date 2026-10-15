import type { CSSProperties } from "react";
import type { FilmLook } from "../look.ts";
import type { DrawnToken } from "../plan.ts";

// A run of display tokens as frameState gave them: each token's typed part, the rest held in
// place but invisible so the line never re-flows as it types; the accent only where frameState
// granted it; `~x~` struck, `_x_` in the mono face.
export function Tokens({ tokens, look, upper = false, color }: { tokens: DrawnToken[]; look: FilmLook; upper?: boolean; color?: string }) {
  return (
    <>
      {tokens.map((tok, i) => {
        const text = upper ? tok.text.toUpperCase() : tok.text;
        const chars = [...text];
        const style: CSSProperties = {
          display: "inline-block",
          whiteSpace: "pre",
          transform: tok.scale !== 1 ? `scale(${tok.scale})` : undefined,
          transformOrigin: "left bottom",
          letterSpacing: tok.spacing ? `${tok.spacing}em` : undefined,
          color: tok.accent ? look.color.accent : (color ?? look.color.white),
          textDecoration: tok.mark === "strike" ? "line-through" : undefined,
          textDecorationThickness: tok.mark === "strike" ? "0.08em" : undefined,
          fontFamily: tok.mark === "mono" ? `"${look.face.mono}", monospace` : undefined,
        };
        return (
          <span key={i}>
            <span style={style}>
              {chars.slice(0, tok.shown).join("")}
              <span style={{ color: "transparent" }}>{chars.slice(tok.shown).join("")}</span>
            </span>
            {i + 1 < tokens.length ? " " : ""}
          </span>
        );
      })}
    </>
  );
}

export const plainOf = (tokens: DrawnToken[], upper = false) => {
  const text = tokens.map((t) => t.text).join(" ");
  return upper ? text.toUpperCase() : text;
};
