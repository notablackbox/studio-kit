import type { FilmLook } from "./look.ts";
import type { FrameState } from "./plan.ts";

// The chrome: a corner HUD in the mono face, top right, reading the song's clock from the beat
// map: SESSION <mm:ss>, BAR <n>, BEAT <n>. frameState hides it under a full-frame card and on
// shots whose chrome is "off".
export function Chrome({ chrome, look }: { chrome: NonNullable<FrameState["chrome"]>; look: FilmLook }) {
  const item = (name: string, value: string) => (
    <span>
      <span style={{ color: look.color.silver, opacity: 0.6 }}>{name} </span>
      <span style={{ color: look.color.silver }}>{value}</span>
    </span>
  );
  return (
    <div
      style={{
        position: "absolute",
        right: look.margin.r,
        top: look.margin.t,
        display: "flex",
        gap: 28,
        fontFamily: `"${look.face.mono}", monospace`,
        fontSize: 22,
        letterSpacing: "0.1em",
        fontVariantNumeric: "tabular-nums",
        textShadow: look.shadow,
      }}
    >
      {item("SESSION", chrome.session)}
      {item("BAR", String(chrome.bar).padStart(2, "0"))}
      {item("BEAT", String(chrome.beat))}
    </div>
  );
}
