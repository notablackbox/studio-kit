import { accentOf, mono, numberOf, panel, stamp, text, type DeviceProps } from "./parts.ts";

// counter: a number that counts on the sixteenths from `from` to its value `to` (at most
// sixteen steps; larger spans move in equal jumps), with its unit beneath in the mono face.
export function counterValue(params: Record<string, unknown>, step: number): number {
  const from = numberOf(params.from, 0);
  const to = numberOf(params.to, from);
  const span = Math.abs(to - from);
  const steps = Math.max(1, Math.min(16, Math.round(span)));
  const u = Math.min(1, step / steps);
  return Math.round(from + (to - from) * u);
}

export function Counter({ device, look }: DeviceProps) {
  const value = counterValue(device.params, device.step);
  const digits = String(Math.round(numberOf(device.params.to, value))).length;
  return (
    <div style={{ ...panel(look), ...stamp(device.age), minWidth: 260 }}>
      <div style={{ ...mono(look, 104, 500), lineHeight: 1, letterSpacing: "-0.02em", color: accentOf(device, look), fontVariantNumeric: "tabular-nums" }}>
        {String(value).padStart(digits, "0")}
      </div>
      <div style={{ ...mono(look, 22), color: look.color.silver, marginTop: 10, textTransform: "uppercase" }}>{text(device.params.unit)}</div>
    </div>
  );
}
