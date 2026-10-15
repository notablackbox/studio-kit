import { mono, stamp, text, type DeviceProps } from "./parts.ts";

// label: a classifier tag that stamps in on its key: the accent's fill with black type when it
// holds the accent, else a silver rule around silver type.
export function Label({ device, look }: DeviceProps) {
  const fill = device.accent;
  return (
    <div
      style={{
        ...mono(look, 26, 500),
        ...stamp(device.age),
        display: "inline-block",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        padding: "8px 16px 9px",
        color: fill ? look.color.black : look.color.silver,
        backgroundColor: fill ? look.color.accent : `${look.color.black}b3`,
        border: `2px solid ${fill ? look.color.accent : look.color.silver}`,
      }}
    >
      {text(device.params.text, "LABEL")}
    </div>
  );
}
