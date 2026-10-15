import { mono, panel, text, type DeviceProps } from "./parts.ts";

// terminal: lines typing in, one a sixteenth, a block caret on the last line that blinks on
// the sixteenths. Silver type on the brand's black; never accented.
export function Terminal({ device, look }: DeviceProps) {
  const raw = device.params.lines;
  const lines = Array.isArray(raw) ? raw.map((l) => text(l)) : text(device.params.text).split("\n");
  const shown = lines.slice(0, Math.min(lines.length, device.step + 1));
  const caret = device.step % 2 === 0 ? "█" : " ";
  return (
    <div style={{ ...panel(look), ...mono(look, 24), color: look.color.silver, width: 640, whiteSpace: "pre-wrap" }}>
      {shown.map((line, i) => (
        <div key={i}>
          <span style={{ color: look.color.graphite }}>{"> "}</span>
          {line}
          {i === shown.length - 1 ? caret : ""}
        </div>
      ))}
    </div>
  );
}
