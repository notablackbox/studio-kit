import { accentOf, text, type DeviceProps } from "./parts.ts";

// strike: a struck-out word in the headline face; the bar crosses it over two sixteenths from
// the key, in the accent when it holds one.
export function Strike({ device, look }: DeviceProps) {
  const word = text(device.params.text, "").toUpperCase();
  const u = Math.min(1, device.step / 2);
  return (
    <div style={{ position: "relative", display: "inline-block", fontFamily: `"${look.face.headline}", sans-serif`, fontSize: 112, lineHeight: 1, color: look.color.white, textShadow: look.shadow }}>
      {word}
      <div style={{ position: "absolute", left: -8, top: "54%", height: 12, width: `calc(${(u * 100).toFixed(2)}% + ${(16 * u).toFixed(2)}px)`, backgroundColor: accentOf(device, look) }} />
    </div>
  );
}
