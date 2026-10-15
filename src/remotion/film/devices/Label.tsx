import { mono, stamp, text, type DeviceProps } from "./parts.ts";

// label: a classifier tag that stamps in on its key: white type on graphite with a rule down
// its left edge, the rule in the accent when the label holds it, else silver. Never a solid
// block of the accent.
export function Label({ device, look }: DeviceProps) {
  return (
    <div
      style={{
        ...mono(look, 26, 500),
        ...stamp(device.age),
        display: "inline-block",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        padding: "8px 18px 9px 16px",
        color: look.color.white,
        backgroundColor: look.color.graphite,
        borderLeft: `6px solid ${device.accent ? look.color.accent : look.color.silver}`,
      }}
    >
      {text(device.params.text, "LABEL")}
    </div>
  );
}
