import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, tempDir } from "./fixtures/film.ts";
import { meanOver, readPng, writePng } from "./fixtures/png.ts";

// film:depth on a synthetic plate: a bright square standing on a ground plane in front of a
// sky, both gradients. Depth Anything V2 Small puts the square near and the sky far; the
// mattes are cut from the depth map's terciles and feathered (ruling R3).

const W = 512;
const H = 384;
const HORIZON = 0.4;
const SQUARE = { x0: 180, x1: 330, y0: 150, y1: H };

function plate(): Buffer {
  return writePng(W, H, (x, y) => {
    const v = y / (H - 1);
    if (x >= SQUARE.x0 && x < SQUARE.x1 && y >= SQUARE.y0 && y < SQUARE.y1) return [250, 250, 245];
    if (v > HORIZON) return [60 + 140 * v, 50 + 110 * v, 40 + 80 * v];
    return [120 + 100 * (1 - v), 150 + 80 * (1 - v), 200 + 50 * (1 - v)];
  });
}

let dir = "";
before(() => {
  dir = tempDir("depth");
  writeFileSync(join(dir, "street.png"), plate());
});

const FILES = ["street.depth.png", "street.near.png", "street.mid.png", "street.far.png", "street.boxes.json"];

test("a depth map, three soft mattes and the boxes; the square is near and the sky far", () => {
  const result = film("depth", dir, ["--plate", "street.png", "--out", "a"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.match(lines(result.stdout)[0], /^depth: "street\.png" 512x384, near \d+%, mid \d+%, far \d+%, no detector$/);
  assert.deepEqual(readdirSync(join(dir, "a")).sort(), [...FILES, "depth-report.json"].sort());

  const depth = readPng(readFileSync(join(dir, "a", "street.depth.png")));
  assert.deepEqual([depth.width, depth.height, depth.depth, depth.channels], [W, H, 16, 1]);
  assert.equal(depth.data.reduce((a, b) => Math.min(a, b)), 0);
  assert.equal(depth.data.reduce((a, b) => Math.max(a, b)), 65535);
  const inside = { x0: SQUARE.x0 + 12, x1: SQUARE.x1 - 12, y0: SQUARE.y0 + 12, y1: SQUARE.y1 - 12 };
  // Near is bright.
  assert.ok(meanOver(depth, inside.x0, inside.y0, inside.x1, inside.y1) > meanOver(depth, 0, 0, 24, 24) + 30000);

  const [near, mid, far] = ["near", "mid", "far"].map((m) => readPng(readFileSync(join(dir, "a", `street.${m}.png`))));
  for (const matte of [near, mid, far]) assert.deepEqual([matte.width, matte.height, matte.depth, matte.channels], [W, H, 8, 1]);
  assert.ok(meanOver(near, inside.x0, inside.y0, inside.x1, inside.y1) > 0.85 * 255, "the near matte covers the square");
  assert.ok(meanOver(far, inside.x0, inside.y0, inside.x1, inside.y1) < 0.02 * 255, "the far matte leaves the square");
  assert.ok(meanOver(far, 0, 0, 24, 24) > 0.9 * 255, "the far matte covers the far corner");
  assert.ok(meanOver(near, 0, 0, 24, 24) < 0.02 * 255, "the near matte leaves the far corner");
  // The three mattes share every pixel between them.
  for (let i = 0; i < W * H; i += 97) {
    const sum = near.data[i] + mid.data[i] + far.data[i];
    assert.ok(Math.abs(sum - 255) <= 2, `pixel ${i}: ${sum}`);
  }
  // Soft: the edge of the near matte ramps over about 2 percent of the width, not one pixel.
  const row = Math.round((SQUARE.y0 + H) / 2);
  const edge = Array.from({ length: 40 }, (_, k) => near.data[row * W + SQUARE.x0 - 20 + k]);
  const between = edge.filter((v) => v > 10 && v < 245).length;
  assert.ok(between >= 4 && between <= 20, `the edge ramps over ${between} px: ${edge}`);

  const boxes = JSON.parse(readFileSync(join(dir, "a", "street.boxes.json"), "utf8"));
  assert.deepEqual(boxes, { faces: [], persons: [], detector: null, note: "no face or person detector in the image" });

  const report = JSON.parse(readFileSync(join(dir, "a", "depth-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { plate: join(dir, "street.png") });
  assert.deepEqual(report.outputs, { depth: FILES[0], near: FILES[1], mid: FILES[2], far: FILES[3], boxes: FILES[4], report: "depth-report.json" });
  assert.deepEqual(report.size, [W, H]);
  assert.equal(report.model.name, "Depth Anything V2 Small");
  assert.equal(report.feather_px, 10);
  assert.equal(report.detector, null);
});

test("the same plate twice gives the same bytes", () => {
  const result = film("depth", dir, ["--plate", "street.png", "--out", "b"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of FILES) assert.ok(readFileSync(join(dir, "a", name)).equals(readFileSync(join(dir, "b", name))), name);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "fake.png"), "not a png at all");
  writeFileSync(join(dir, "small.png"), writePng(200, 120, () => [0, 0, 0]));
  writeFileSync(join(dir, "thin.png"), writePng(1024, 255, () => [0, 0, 0]));
  writeFileSync(join(dir, "afile"), "x");
  mkdirSync(join(dir, "nomodels"));
  const cases: [string[], string, NodeJS.ProcessEnv?][] = [
    [["--plate", "street.png"], "film:depth: --plate <png> and --out <dir> are required"],
    [["--plate", "nope.png", "--out", "x"], "--plate cannot be read"],
    [["--plate", "fake.png", "--out", "x"], "--plate is not a PNG"],
    [["--plate", "small.png", "--out", "x"], "--plate is 200x120 px, want at least 256 px on each side"],
    [["--plate", "thin.png", "--out", "x"], "--plate is 1024x255 px, want at least 256 px on each side"],
    [["--plate", "street.png", "--out", "afile"], "--out is not a folder"],
    [["--plate", "street.png", "--out", "x"], `model depth is not in ${JSON.stringify(join(dir, "nomodels"))} (run python3 -I src/film/py/film_py/models.py --dest ${JSON.stringify(join(dir, "nomodels"))})`, { FILM_MODELS: join(dir, "nomodels") }],
  ];
  for (const [args, line, env] of cases) {
    const result = film("depth", dir, args, env);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  const result = film("depth", dir, ["--plate", "street.png", "--out", "y"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:depth: python film_py.depth failed"]);
  assert.equal(existsSync(join(dir, "y")), false);
});
