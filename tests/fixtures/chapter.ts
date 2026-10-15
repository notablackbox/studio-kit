import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, tempDir } from "./film.ts";
import { boardFixture } from "./board.ts";
import { writePng } from "./png.ts";

// The chapter tests' project: the board fixture's analysis of the synthetic song, a ten-second
// chapter board built for the renderer (one still plate, one sung shot on a fake take, a still
// carrying a line across a cut, genuine footage, a 2.5D shot with a treatment entering on a
// dither, a design shot with a masthead; two devices; the chrome), its plates and mattes, the
// fake take and the footage made with ffmpeg's test sources, and the edit list film:edl makes.

export const CHAPTER_BOARD = {
  version: 1,
  duration: 12.0,
  chapters: [
    { id: "ch01", name: "Wake", t0: 0.0, t1: 10.0, sections: ["Verse", "Chorus"], accent: "#D97757", set: "a city street at dawn", box: "the street" },
    { id: "ch02", name: "Hold", t0: 10.0, t1: 12.0, sections: ["Chorus"], accent: "#D97757", set: "a rooftop at first light", box: "the roof" },
  ],
  shots: [
    {
      id: "s001", t0: 0.0, t1: 0.976, section: "Verse", lines: [], set: "an empty city street at dawn", lead_on_screen: false, framing: "EWS",
      action: "The street lamps go out.", camera: "locked", motion_tier: "still", plate: "p-dawn", clip: null, prompt: "extreme wide shot of a street at dawn, no text, no letters, no logos",
      type: [], devices: [], treatment: null, transition_in: "cut", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
    {
      id: "s002", t0: 0.976, t1: 3.987, section: "Verse", lines: [0, 1], set: "a doorway", lead_on_screen: true, framing: "CU",
      action: "She speaks the verse into the lens.", camera: "slow push in", motion_tier: "sung", plate: "p-street", clip: "W01", prompt: "close-up in a doorway, no text, no letters, no logos",
      type: [
        { line: 0, mode: "subtitle", text: "The city wakes.", placement: "lower third" },
        { line: 1, mode: "subtitle", text: "We count the windows.", placement: "lower third" },
      ],
      devices: [
        { kind: "label", anchor: { slot: "right" }, params: { text: "CITY STATUS: AWAKE" }, key: "W", line: 0 },
        { kind: "counter", anchor: { slot: "right" }, params: { from: 0, to: 14, unit: "WINDOWS LIT" }, key: "W", line: 1 },
      ],
      treatment: null, transition_in: "cut", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
    {
      id: "s003", t0: 3.987, t1: 5.473, section: "Verse", lines: [1], set: "the street, the windows across", lead_on_screen: false, framing: "WS",
      action: "The windows light one by one.", camera: "locked", motion_tier: "still", plate: "p-street", clip: null, prompt: "wide shot of windows, no text, no letters, no logos",
      type: [{ line: 1, mode: "subtitle", text: "We count the windows.", placement: "lower third" }],
      devices: [], treatment: null, transition_in: "cut", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
    {
      id: "s004", t0: 5.473, t1: 6.462, section: "Verse", lines: [], set: "the dashboard on a phone", lead_on_screen: false, framing: "ECU",
      action: "The dashboard counts the windows.", camera: "locked", motion_tier: "still", plate: "p-street", clip: null, genuine: true, footage: "shot-01.mp4",
      prompt: "a phone screen, no text, no letters, no logos", type: [], devices: [], treatment: null, transition_in: "cut", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
    {
      id: "s005", t0: 6.462, t1: 8.432, section: "Chorus", lines: [2], set: "a rooftop at first light", lead_on_screen: true, framing: "WS",
      action: "She raises a hand to the sun.", camera: "the layers part", motion_tier: "plate3d", plate: "p-roof", clip: null, prompt: "a rooftop, no text, no letters, no logos",
      type: [{ line: 2, mode: "subtitle", text: "Hold on,", placement: "lower third" }],
      devices: [], treatment: "push", transition_in: "dither", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
    {
      id: "s006", t0: 8.432, t1: 10.0, section: "Chorus", lines: [3], set: "black", lead_on_screen: false, framing: null,
      action: "The headline lands.", camera: "locked", motion_tier: "still", plate: null, clip: null, prompt: "",
      type: [{ line: 3, mode: "masthead", text: "HOLD THE LIGHT", placement: "left third" }],
      devices: [], treatment: null, transition_in: "cut", chrome: "off", accent: "#D97757", notes: "",
    },
    {
      id: "s007", t0: 10.0, t1: 12.0, section: "Chorus", lines: [], set: "the street again", lead_on_screen: false, framing: "EWS",
      action: "The street, awake.", camera: "locked", motion_tier: "still", plate: "p-dawn", clip: null, prompt: "a street, no text, no letters, no logos",
      type: [], devices: [], treatment: null, transition_in: "cut", chrome: "the corner HUD", accent: "#D97757", notes: "",
    },
  ],
  plates: [
    { plate: "p-dawn", set: "a street at dawn", prompt: "a street, no text, no letters, no logos", aspect: "16:9", used_by: ["s001", "s007"] },
    { plate: "p-street", set: "a doorway", prompt: "a doorway, no text, no letters, no logos", aspect: "16:9", used_by: ["s002", "s003"] },
    { plate: "p-roof", set: "a rooftop", prompt: "a rooftop, no text, no letters, no logos", aspect: "16:9", used_by: ["s005"] },
  ],
};

const W = 640;
const H = 360;
const mix = (a: number[], b: number[], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// Small painted plates: a dawn street, a doorway, a rooftop with a water tank standing near.
function plates(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "p-dawn.png"), writePng(W, H, (x, y) => {
    if (y < H * 0.55) return mix([38, 46, 88], [238, 170, 120], y / (H * 0.55));
    const block = Math.floor(x / 64) % 2 === 0 && y < H * 0.75 ? 0.75 : 1;
    return mix([70, 64, 66], [30, 28, 32], (y - H * 0.55) / (H * 0.45)).map((v) => v * block) as [number, number, number];
  }));
  writeFileSync(join(dir, "p-street.png"), writePng(W, H, (x, y) => {
    const door = x > W * 0.58 && x < W * 0.8 && y > H * 0.18;
    if (door) return mix([52, 40, 34], [24, 20, 18], (y - H * 0.18) / (H * 0.82));
    const lit = (Math.floor(x / 40) + Math.floor(y / 48)) % 5 === 0 && y < H * 0.7 && x < W * 0.5;
    return lit ? [230, 190, 120] : mix([120, 108, 96], [64, 58, 54], y / H);
  }));
  const tank = (x: number, y: number) => x > W * 0.6 && x < W * 0.86 && y > H * 0.3;
  writeFileSync(join(dir, "p-roof.png"), writePng(W, H, (x, y) => {
    if (tank(x, y)) return mix([96, 84, 74], [44, 38, 34], (x - W * 0.6) / (W * 0.26));
    if (y < H * 0.62) return mix([70, 110, 170], [250, 200, 150], y / (H * 0.62));
    return mix([58, 56, 60], [26, 26, 30], (y - H * 0.62) / (H * 0.38));
  }));
  // A bright overcast sky: what a card flashing over it makes a flash of.
  writeFileSync(join(dir, "p-white.png"), writePng(W, H, () => [236, 236, 232]));
  // R3's three mattes for p-roof: near (the tank and the roof's edge), far (the sky), mid (the rest).
  const near = (x: number, y: number) => tank(x, y) || y > H * 0.86;
  const far = (_x: number, y: number) => y < H * 0.62;
  const grey = (v: boolean): [number, number, number] => (v ? [255, 255, 255] : [0, 0, 0]);
  writeFileSync(join(dir, "p-roof.near.png"), writePng(W, H, (x, y) => grey(near(x, y))));
  writeFileSync(join(dir, "p-roof.far.png"), writePng(W, H, (x, y) => grey(!near(x, y) && far(x, y))));
  writeFileSync(join(dir, "p-roof.mid.png"), writePng(W, H, (x, y) => grey(!near(x, y) && !far(x, y))));
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// A fake take (ffmpeg's testsrc2, 1280x720 at 24 fps) and a piece of footage (SMPTE bars).
export function fakeVideo(file: string, seconds: number, source = "testsrc2", size = "1280x720"): string {
  ffmpeg(["-f", "lavfi", "-i", `${source}=size=${size}:rate=24:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
  return file;
}

export type ChapterProject = { dir: string; args: (out: string, extra?: string[]) => string[] };

// The project folder: board/shots.json, analysis/, plates/, clips/, footage/, edit/edl.json.
export function chapterProject(board: unknown = CHAPTER_BOARD): ChapterProject {
  const dir = tempDir("chapter");
  mkdirSync(join(dir, "board"));
  writeFileSync(join(dir, "board", "shots.json"), JSON.stringify(board, null, 2) + "\n");
  cpSync(join(boardFixture, "analysis"), join(dir, "analysis"), { recursive: true });
  cpSync(join(boardFixture, "clips"), join(dir, "clips"), { recursive: true });
  plates(join(dir, "plates"));
  mkdirSync(join(dir, "clips", "W01"), { recursive: true });
  fakeVideo(join(dir, "clips", "W01", "take-2.mp4"), 4);
  mkdirSync(join(dir, "footage"));
  fakeVideo(join(dir, "footage", "shot-01.mp4"), 2, "smptebars");
  const edl = film("edl", dir, ["--board", "board/shots.json", "--clips", "clips", "--words", "analysis/words.json", "--out", "edit"]);
  assert.equal(edl.status, 0, edl.stdout + edl.stderr);
  return {
    dir,
    args: (out, extra = []) => [
      "--board", "board/shots.json", "--edl", "edit/edl.json", "--words", "analysis/words.json", "--beats", "analysis/beats.json",
      "--hits", "analysis/hits.json", "--display", "analysis/display.txt", "--plates", "plates", "--clips", "clips", "--footage", "footage",
      "--chapter", "ch01", "--out", out, ...extra,
    ],
  };
}

export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
