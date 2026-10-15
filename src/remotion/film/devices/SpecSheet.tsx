import { mono, panel, text, type DeviceProps } from "./parts.ts";

// spec-sheet: a title and rows of key and value typing in, one row a sixteenth after the title.
export function SpecSheet({ device, look }: DeviceProps) {
  const raw = Array.isArray(device.params.rows) ? device.params.rows : [];
  const rows = raw.map((r) => (Array.isArray(r) ? [text(r[0]), text(r[1])] : [text(r), ""]));
  const shown = rows.slice(0, Math.max(0, Math.min(rows.length, device.step)));
  return (
    <div style={{ ...panel(look), ...mono(look, 24), width: 600, color: look.color.white }}>
      <div style={{ ...mono(look, 20, 500), color: look.color.silver, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>{text(device.params.title, "SPEC")}</div>
      {shown.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${look.color.graphite}`, padding: "6px 0" }}>
          <span style={{ color: look.color.silver }}>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
