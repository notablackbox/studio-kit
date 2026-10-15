import type { CSSProperties, ReactNode } from "react";
import type { FilmLook } from "../look.ts";
import type { DeviceSlot, DrawnDevice } from "../plan.ts";
import { Chart } from "./Chart.tsx";
import { Counter } from "./Counter.tsx";
import { Label } from "./Label.tsx";
import { SpecSheet } from "./SpecSheet.tsx";
import { Strike } from "./Strike.tsx";
import { Terminal } from "./Terminal.tsx";

// The six devices of R4, placed by their anchors: a named slot (plan.ts's DEVICE_SLOTS: left,
// right, top, bottom, centre, and the four corners) where devices of one slot stack in board order, or `{x, y}`
// in percent of the frame. In 9:16 every device stacks in the band above the picture.

function one(device: DrawnDevice, look: FilmLook): ReactNode {
  const props = { device, look };
  if (device.kind === "counter") return <Counter {...props} />;
  if (device.kind === "label") return <Label {...props} />;
  if (device.kind === "terminal") return <Terminal {...props} />;
  if (device.kind === "chart") return <Chart {...props} />;
  if (device.kind === "strike") return <Strike {...props} />;
  return <SpecSheet {...props} />;
}

// The named slots share four columns, so devices never land on one another: the left and the
// right column (from under the chrome down), and the two bottom corners above the lyric band.
const COLUMN: Partial<Record<DeviceSlot, DeviceSlot>> = { left: "left", top: "left", "top-left": "left", right: "right", "top-right": "right" };

function slotStyle(slot: string, look: FilmLook): CSSProperties {
  const { margin, width } = look;
  const column: CSSProperties = { position: "absolute", display: "flex", flexDirection: "column", gap: 24 };
  switch (slot) {
    case "left":
      return { ...column, left: margin.l, top: margin.t + 90, alignItems: "flex-start" };
    case "bottom":
    case "bottom-left":
      return { ...column, left: margin.l, bottom: margin.b + 150, alignItems: "flex-start" };
    case "bottom-right":
      return { ...column, right: margin.r, bottom: margin.b + 150, alignItems: "flex-end" };
    case "centre":
    case "center":
      return { ...column, left: 0, width, top: "50%", transform: "translateY(-50%)", alignItems: "center" };
    default:
      return { ...column, right: margin.r, top: margin.t + 90, alignItems: "flex-end" };
  }
}

export function Devices({ devices, look, scale = 1 }: { devices: DrawnDevice[]; look: FilmLook; scale?: number }) {
  if (devices.length === 0) return null;
  if (look.vertical) {
    const { above } = look;
    return (
      // The shot's devices stepped down together (plan.ts sizes them so they fit; never clipped).
      <div style={{ position: "absolute", left: above.x, top: above.y, width: above.w / scale, display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "flex-start", gap: 20, transform: `scale(${scale})`, transformOrigin: "left top" }}>
        {devices.map((d) => (
          <div key={d.index}>{one(d, look)}</div>
        ))}
      </div>
    );
  }
  const slots = new Map<string, DrawnDevice[]>();
  const placed: ReactNode[] = [];
  for (const d of devices) {
    if ("slot" in d.anchor) {
      const column = COLUMN[d.anchor.slot as DeviceSlot] ?? d.anchor.slot;
      const list = slots.get(column) ?? [];
      list.push(d);
      slots.set(column, list);
    } else {
      placed.push(
        <div key={`xy-${d.index}`} style={{ position: "absolute", left: `${d.anchor.x}%`, top: `${d.anchor.y}%` }}>
          {one(d, look)}
        </div>,
      );
    }
  }
  return (
    <>
      {[...slots.entries()].map(([slot, list]) => (
        <div key={slot} style={slotStyle(slot, look)}>
          {list.map((d) => (
            <div key={d.index}>{one(d, look)}</div>
          ))}
        </div>
      ))}
      {placed}
    </>
  );
}
