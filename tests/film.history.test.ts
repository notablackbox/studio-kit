import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./fixtures/film.ts";
import { writePng } from "./fixtures/png.ts";
import { compareImages } from "../src/film/history.ts";

// film:history's comparison on prepared images: the largest channel difference, where it is,
// and how many channels are over the 40-level limit.

test("two PNGs one pixel apart by 50 levels: worst 50 at that pixel, one channel over 40", async () => {
  const dir = tempDir("history");
  const base = (x: number, y: number): [number, number, number] => [(x * 7) % 256, (y * 11) % 256, 90];
  writeFileSync(join(dir, "a.png"), writePng(32, 16, base));
  writeFileSync(join(dir, "b.png"), writePng(32, 16, (x, y) => (x === 5 && y === 9 ? [base(x, y)[0], base(x, y)[1], 140] : base(x, y))));
  writeFileSync(join(dir, "c.png"), writePng(32, 16, (x, y) => (x === 20 && y === 3 ? [base(x, y)[0] + 30, base(x, y)[1], 90] : base(x, y))));
  assert.deepEqual(await compareImages(join(dir, "a.png"), join(dir, "b.png"), dir), { worst: 50, at: { x: 5, y: 9 }, over: 1, width: 32, height: 16 });
  // 30 levels is under the limit: no channel over.
  assert.deepEqual(await compareImages(join(dir, "a.png"), join(dir, "c.png"), dir), { worst: 30, at: { x: 20, y: 3 }, over: 0, width: 32, height: 16 });
  assert.deepEqual(await compareImages(join(dir, "a.png"), join(dir, "a.png"), dir), { worst: 0, at: null, over: 0, width: 32, height: 16 });
});
