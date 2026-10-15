import { mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EXIT, Refused, fromCaller, isMain, outProblem, parseFlags, python, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";

// film:depth: what the 2.5D moves, the type and the camera need from a plate (claudia.gallery's
// toolkit wiki, item 12; ruling R3): its depth map from Depth Anything V2 Small, as a 16-bit
// grey PNG with near bright, three soft mattes (near, mid, far) cut from the map's terciles and
// feathered over 2 percent of the width, and the face and person boxes (empty lists and a note:
// the image has no detector). Writes <name>.depth.png, <name>.near.png, <name>.mid.png,
// <name>.far.png and <name>.boxes.json in --out, <name> being the plate's file name less .png.

const COMMAND = "film:depth";
const TIMEOUT_MS = 10 * 60 * 1000;
const MIN_SIDE = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Made = {
  files: { depth: string; near: string; mid: string; far: string; boxes: string };
  size: [number, number];
  model: Record<string, unknown>;
  raw_range: [number, number];
  terciles: [number, number];
  share: { near: number; mid: number; far: number };
  feather_px: number;
  detector: null;
  seconds: number;
};

// The plate's size from its PNG header, or a refusal: not a PNG, or too small for the model.
function pngSize(file: string): [number, number] {
  const head = Buffer.alloc(24);
  const fd = openSync(file, "r");
  let read = 0;
  try {
    read = readSync(fd, head, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 24 || !head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString("ascii", 12, 16) !== "IHDR") throw new Refused(["--plate is not a PNG"]);
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (width < MIN_SIDE || height < MIN_SIDE) throw new Refused([`--plate is ${width}x${height} px, want at least ${MIN_SIDE} px on each side`]);
  return [width, height];
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    plate: { type: "string" },
    out: { type: "string" },
  });
  if (!values.plate || !values.out) throw new Refused([`${COMMAND}: --plate <png> and --out <dir> are required`]);
  const plate = requireFile(fromCaller(values.plate), "--plate");
  pngSize(plate);
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  const name = basename(plate).replace(/\.png$/i, "");

  const work = mkdtempSync(join(tmpdir(), "film-depth-"));
  try {
    const made = await python<Made>("depth", [JSON.stringify({ plate, dest: work, name })], TIMEOUT_MS);
    const keys = ["depth", "near", "mid", "far", "boxes"] as const;
    for (const key of keys) writeIn(out, made.files[key], readFileSync(join(work, made.files[key])));
    writeReport(out, "depth", {
      ok: true,
      inputs: { plate },
      outputs: { ...made.files, report: "depth-report.json" },
      size: made.size,
      model: made.model,
      raw_range: made.raw_range,
      terciles: made.terciles,
      share: made.share,
      feather_px: made.feather_px,
      detector: made.detector,
      seconds: made.seconds,
    });
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    console.log(`depth: ${shown(basename(plate))} ${made.size[0]}x${made.size[1]}, near ${pct(made.share.near)}, mid ${pct(made.share.mid)}, far ${pct(made.share.far)}, no detector`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
