import { AbsoluteFill, Freeze, Img, OffthreadVideo, staticFile } from "remotion";
import type { Layer, Move } from "../plan.ts";

// One picture: a take or footage frame (OffthreadVideo held at the exact clip frame frameState
// computed, so no frame depends on the one before), a still plate, the three-layer 2.5D of R3,
// or the brand's black. It fills its box (cover); the box is the frame in 16:9 and the
// picture band in 9:16.

const fill = { width: "100%", height: "100%", objectFit: "cover" as const, display: "block" };

function moved(m: Move) {
  return { transform: `translate(${m.x}%, ${m.y}%) scale(${m.scale})`, transformOrigin: "50% 50%" };
}

export function Picture({ layer, black }: { layer: Layer; black: string }) {
  if (layer.kind === "video") {
    return (
      <AbsoluteFill style={{ backgroundColor: black }}>
        {/* Held at the composition's frame 0 and trimmed to the clip frame, so the clip frame is
            never clamped to the composition's length (a take may run longer than its chapter). */}
        <Freeze frame={0}>
          <OffthreadVideo src={staticFile(layer.src)} trimBefore={layer.frame} muted style={fill} />
        </Freeze>
      </AbsoluteFill>
    );
  }
  if (layer.kind === "still") {
    return (
      <AbsoluteFill style={{ backgroundColor: black }}>
        <Img src={staticFile(layer.src)} style={fill} />
      </AbsoluteFill>
    );
  }
  if (layer.kind === "layers") {
    // Far is the whole plate; mid and near are the plate cut by their soft mattes (staged by
    // film:chapter as PNGs with alpha), so the far layer shows wherever a nearer one moves off.
    return (
      <AbsoluteFill style={{ backgroundColor: black, overflow: "hidden" }}>
        {(["far", "mid", "near"] as const).map((key) => (
          <AbsoluteFill key={key} style={moved(layer.move[key])}>
            <Img src={staticFile(layer[key])} style={fill} />
          </AbsoluteFill>
        ))}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ backgroundColor: black }} />;
}
