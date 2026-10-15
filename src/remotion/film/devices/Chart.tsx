import { accentOf, mono, panel, text, type DeviceProps } from "./parts.ts";

// chart: a line (or bars, `style: "bar"`) from `params.series`, one point a sixteenth from its
// key. A series given by name, not by numbers, draws a plain rise in eight steps under that name.
export function seriesOf(params: Record<string, unknown>): number[] {
  const raw = params.series;
  if (Array.isArray(raw)) {
    const values = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length >= 2) return values;
  }
  return [0.12, 0.18, 0.27, 0.38, 0.52, 0.66, 0.8, 0.92];
}

export function Chart({ device, look }: DeviceProps) {
  const values = seriesOf(device.params);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values, lo + 1e-6);
  const w = 520;
  const h = 220;
  const shown = Math.min(values.length, device.step + 1);
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * w);
  const y = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  const colour = accentOf(device, look);
  const name = typeof device.params.series === "string" ? device.params.series : text(device.params.title);
  const bars = device.params.style === "bar";
  const points = values.slice(0, shown).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <div style={{ ...panel(look), width: w + 40 }}>
      <div style={{ ...mono(look, 20, 500), color: look.color.silver, textTransform: "uppercase", marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
        <span>{name}</span>
        <span>{text(device.params.unit)}</span>
      </div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
        <line x1={0} y1={h} x2={w} y2={h} stroke={look.color.graphite} strokeWidth={2} />
        {bars
          ? values.slice(0, shown).map((v, i) => {
              const bw = (w / values.length) * 0.6;
              const bx = (i + 0.2) * (w / values.length);
              return <rect key={i} x={bx} y={y(v)} width={bw} height={h - y(v)} fill={colour} />;
            })
          : <polyline points={points.join(" ")} fill="none" stroke={colour} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />}
        {!bars && shown > 0 ? <circle cx={x(shown - 1)} cy={y(values[shown - 1])} r={7} fill={colour} /> : null}
      </svg>
    </div>
  );
}
