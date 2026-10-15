import type { FilmLook } from "../look.ts";
import type { DrawnBlock } from "../plan.ts";
import { Coverline } from "./Coverline.tsx";
import { Mass } from "./Mass.tsx";
import { Masthead } from "./Masthead.tsx";
import { Stack } from "./Stack.tsx";
import { Subtitle } from "./Subtitle.tsx";

// The five type modes of R4, each drawing exactly the tokens frameState handed it.
export function TypeBlock({ block, look }: { block: DrawnBlock; look: FilmLook }) {
  if (block.mode === "subtitle") return <Subtitle block={block} look={look} />;
  if (block.mode === "coverline") return <Coverline block={block} look={look} />;
  if (block.mode === "masthead") return <Masthead block={block} look={look} />;
  if (block.mode === "stack") return <Stack block={block} look={look} />;
  return <Mass block={block} look={look} />;
}
