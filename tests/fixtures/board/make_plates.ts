import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePng } from "../png.ts";

// Writes the board fixture's plates: three small 16:9 colour fields, so film:sheet has an
// image for p-dawn, p-street and p-window and a prompt card for p-roof (left out on purpose).
//
//     node --import tsx tests/fixtures/board/make_plates.ts
//
// Deterministic: the same bytes every run.

const PLATES: [string, [number, number, number], [number, number, number]][] = [
  ["p-dawn", [32, 40, 72], [236, 168, 120]],
  ["p-street", [60, 52, 48], [200, 190, 170]],
  ["p-window", [12, 14, 20], [90, 160, 220]],
];

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "plates");
for (const [name, top, bottom] of PLATES) {
  const png = writePng(96, 54, (_x, y) => {
    const k = y / 53;
    return [top[0] + (bottom[0] - top[0]) * k, top[1] + (bottom[1] - top[1]) * k, top[2] + (bottom[2] - top[2]) * k];
  });
  writeFileSync(join(dir, `${name}.png`), png);
}
