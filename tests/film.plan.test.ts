import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kitRoot } from "./fixtures/film.ts";
import { boardFixture } from "./fixtures/board.ts";
import { CHAPTER_BOARD } from "./fixtures/chapter.ts";
import {
  audioEvents,
  bayer,
  buildPlan,
  cardOpacity,
  ditherPath,
  frameAt,
  frameState,
  parseTokens,
  plainText,
  sixteenthGrid,
  tokensSidecar,
  treatmentMove,
  type Media,
  type Plan,
} from "../src/remotion/film/plan.ts";

// The chapter engine's pure core: the plan built from the board, the edit list and the
// analysis, and frameState, the one function both the composition and the sidecar use.

const analysis = (name: string) => JSON.parse(readFileSync(join(boardFixture, "analysis", name), "utf8"));
const EDL = {
  s001: { plate: "p-dawn" },
  s002: { segs: [{ t0: 0.976, clip: "W01-t2", in: 0.31 }] },
  s003: { plate: "p-street" },
  s004: { footage: "shot-01.mp4" },
  s005: { plate: "p-roof" },
  s006: { design: true },
  s007: { plate: "p-dawn" },
};
const MEDIA: Media = {
  plates: { "p-dawn": "plates/p-dawn.png", "p-street": "plates/p-street.png", "p-roof": "plates/p-roof.png" },
  layers: { "p-roof": { far: "plates/p-roof.png", mid: "plates/p-roof.mid.layer.png", near: "plates/p-roof.near.layer.png" } },
  clips: { "W01-t2": "clips/W01/take-2.mp4" },
  footage: { "shot-01.mp4": "footage/f001.mp4" },
  frames: { "clips/W01/take-2.mp4": 96, "footage/f001.mp4": 48 },
};
const palette = JSON.parse(readFileSync(join(kitRoot, "brand", "palette.json"), "utf8"));

function plan(board: unknown = CHAPTER_BOARD, extra: Partial<Parameters<typeof buildPlan>[0]> = {}): Plan {
  const built = buildPlan({
    chapter: "ch01",
    board,
    edl: EDL,
    words: analysis("words.json"),
    beats: analysis("beats.json"),
    hits: analysis("hits.json"),
    display: readFileSync(join(boardFixture, "analysis", "display.txt"), "utf8"),
    palette,
    media: MEDIA,
    ...extra,
  });
  assert.deepEqual(built.problems, []);
  return built.plan as Plan;
}

test("display tokens: TEXT|n counts, markers, |0 riding on the next token", () => {
  assert.deepEqual(parseTokens("+25%|3 =|1 *AGI*|2 ~old~ _mono_, x|0"), [
    { text: "+25%", count: 3, mark: null },
    { text: "=", count: 1, mark: null },
    { text: "AGI", count: 2, mark: "accent" },
    { text: "old", count: 1, mark: "strike" },
    { text: "mono,", count: 1, mark: "mono" },
    { text: "x", count: 0, mark: null },
  ]);
  assert.equal(plainText("Feel the *AGI*|5 now|0"), "Feel the AGI now");
});

test("the sixteenths: the beats, their eighths and the eighths' midpoints", () => {
  const grid = sixteenthGrid([0, 0.5, 1.0, 1.6], 2);
  assert.deepEqual(grid.slice(0, 13), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.15, 1.3, 1.45, 1.6]);
  // Past the last beat the last spacing carries on.
  assert.equal(grid[13], 1.75);
});

test("a ten-second chapter: 240 frames from the song's frame 0, every shot planned", () => {
  const p = plan();
  assert.equal(p.from, 0);
  assert.equal(p.to, 240);
  assert.deepEqual(p.shots.map((s) => [s.id, s.from, s.to]), [
    ["s001", 0, 24], ["s002", 24, 96], ["s003", 96, 132], ["s004", 132, 156], ["s005", 156, 203], ["s006", 203, 240], ["s007", 240, 288],
  ]);
  // The design shot and its masthead are one card, from 203 to the chapter's end.
  assert.deepEqual(p.cards, [[203, 240]]);
  // Colours come from the brand only: the board's #D97757 is not in the palette, so the
  // palette's productGreen is the accent.
  assert.equal(p.shots[1].accent, palette.productGreen.hex);
});

test("every sung word's token is drawn from the first frame at or after its start, never before", () => {
  const p = plan();
  const words = analysis("words.json").words as { i: number; t0: number }[];
  const sidecar = tokensSidecar(p, 0, 239);
  for (const w of words) {
    const f = frameAt(w.t0);
    const at = (k: number) => sidecar.frames[k].tokens.some((t) => t.word === w.i);
    assert.ok(at(f), `word ${w.i} at frame ${f}`);
    // Never before the voice.
    assert.ok(!at(f - 1), `word ${w.i} is drawn before it is sung`);
  }
  // At the cut into s003, line 1's first two words are already on screen.
  assert.deepEqual(frameState(p, 96).tokens.map((t) => t.word), [3, 4]);
});

test("frameState is a pure function of the frame: in order, out of order and repeated, the same", () => {
  const p = plan();
  const forward = Array.from({ length: 240 }, (_, f) => JSON.stringify(frameState(p, f)));
  const backward = Array.from({ length: 240 }, (_, k) => 239 - k).map((f) => JSON.stringify(frameState(p, f))).reverse();
  assert.deepEqual(forward, backward);
  assert.equal(JSON.stringify(frameState(plan(), 191)), forward[191]);
});

test("at most two accented elements on any frame", () => {
  const p = plan();
  for (let f = 0; f < 240; f++) {
    const s = frameState(p, f);
    const n = s.blocks.flatMap((b) => b.tokens).filter((t) => t.accent).length + s.devices.filter((d) => d.accent).length;
    assert.ok(n <= 2, `frame ${f} has ${n} accents`);
  }
  // On 2.995 s the sung "we", the label and the counter all want it: the counter falls back.
  const s = frameState(p, frameAt(3.0));
  assert.deepEqual(s.devices.map((d) => [d.kind, d.accent]), [["label", true], ["counter", false]]);
});

test("a card ramps over three frames each side (R4), and switches at once under --no-ramp", () => {
  const p = plan();
  assert.deepEqual([199, 200, 201, 202, 203].map((f) => cardOpacity(p, f)), [0, 0.25, 0.5, 0.75, 1]);
  const q = plan(CHAPTER_BOARD, { ramp: false });
  assert.deepEqual([201, 202, 203].map((f) => cardOpacity(q, f)), [0, 0, 1]);
  // The masthead's words show only on the full card, and the chrome hides under any of it.
  assert.equal(frameState(p, 200).chrome, null);
  assert.ok(frameState(p, 199).chrome);
  assert.deepEqual(frameState(p, 203).blocks.map((b) => b.mode), ["masthead"]);
});

test("a dither runs twelve frames over the outgoing shot, each cell switching once", () => {
  const p = plan();
  const states = Array.from({ length: 13 }, (_, k) => frameState(p, 156 + k));
  assert.deepEqual(states.map((s) => s.dither), [...Array.from({ length: 12 }, (_, k) => Math.round(((k + 1) / 12) * 10000) / 10000), null]);
  assert.equal(states[0].under?.shot, "s004");
  assert.equal(states[0].under?.layer.kind, "video");
  // The 8x8 Bayer thresholds are 64 distinct steps: a cell on at p stays on at every later p.
  const cells = new Set(Array.from({ length: 64 }, (_, k) => bayer(k % 8, Math.floor(k / 8))));
  assert.equal(cells.size, 64);
  const count = (path: string) => (path.match(/M/g) ?? []).length;
  assert.ok(count(ditherPath(1920, 1080, 24, 0.25)) > 0);
  assert.equal(ditherPath(1920, 1080, 24, 1), "M0 0H1920V1080H0Z");
});

test("the six treatments move the layers 2 to 4 percent, near most, as a pure function of time", () => {
  for (const treatment of ["push", "drift", "parallax-left", "parallax-right", "rise", "settle"] as const) {
    const a = treatmentMove(treatment, 6.462, 6.462, 8.432);
    const b = treatmentMove(treatment, 8.432, 6.462, 8.432);
    const span = (k: "far" | "mid" | "near") => Math.max(Math.abs(b[k].x - a[k].x), Math.abs(b[k].y - a[k].y), (Math.abs(b[k].scale - a[k].scale) / 1.06) * 100);
    assert.ok(span("near") >= 2 && span("near") <= 4.0001, `${treatment} near ${span("near")}`);
    assert.ok(span("far") < span("mid") && span("mid") < span("near"), treatment);
    assert.deepEqual(treatmentMove(treatment, 7, 6.462, 8.432), treatmentMove(treatment, 7, 6.462, 8.432));
  }
});

test("a take plays at clip time in + (t - t0), holding its last frame past its end", () => {
  const p = plan();
  const at = (f: number) => frameState(p, f).layer;
  assert.deepEqual(at(24), { kind: "video", src: "clips/W01/take-2.mp4", frame: Math.round((0.31 + (1 - 0.976)) * 24) });
  // Footage plays from its first frame; 48 frames long, so it never runs out in s004.
  assert.deepEqual(at(132), { kind: "video", src: "footage/f001.mp4", frame: Math.round((5.5 - 5.473) * 24) });
  assert.equal(frameState(p, 180).layer.kind, "layers");
});

test("devices enter on their key, step on sixteenths; the chrome reads the beat map", () => {
  const p = plan();
  const counter = (f: number) => frameState(p, f).devices.find((d) => d.kind === "counter");
  assert.equal(counter(frameAt(2.995) - 1), undefined);
  assert.equal(counter(frameAt(2.995))?.step, 0);
  assert.ok((counter(90)?.step ?? 0) > 0);
  assert.deepEqual(frameState(p, 48).chrome, { session: "00:02", bar: 1, beat: 4 });
  assert.deepEqual(frameState(p, 0).chrome, { session: "00:00", bar: 0, beat: 0 });
});

test("the sound events: each device's entrance and each dither, inside the chapter", () => {
  assert.deepEqual(audioEvents(plan()).map((e) => [e.t, e.kind, e.what]), [
    [1.0, "stamp", "label"],
    [3.0, "tick", "counter"],
    [6.5, "whoosh", "dither"],
  ]);
});

test("a type entry that does not consume its line's sung words, and a 2.5D shot without a treatment, are problems", () => {
  const board = structuredClone(CHAPTER_BOARD) as typeof CHAPTER_BOARD;
  board.shots[1].type[0].text = "The city|2 wakes up";
  (board.shots[4] as Record<string, unknown>).treatment = null;
  const built = buildPlan({
    chapter: "ch01", board, edl: EDL, words: analysis("words.json"), beats: analysis("beats.json"), hits: analysis("hits.json"),
    display: "", palette, media: { ...MEDIA, clips: {} },
  });
  assert.equal(built.plan, null);
  assert.deepEqual(built.problems, [
    '--clips: "s002" plays take "W01-t2", which is not in the clips folder',
    '--board: "s002" type[0] shows 5 sung words, line 0 has 3 in words.json',
    '--board: "s005" is plate3d and needs a treatment (one of push, drift, parallax-left, parallax-right, rise, settle)',
  ]);
});

const problemsOf = (board: unknown, extra: Partial<Parameters<typeof buildPlan>[0]> = {}) =>
  buildPlan({
    chapter: "ch01", board, edl: EDL, words: analysis("words.json"), beats: analysis("beats.json"), hits: analysis("hits.json"),
    display: readFileSync(join(boardFixture, "analysis", "display.txt"), "utf8"), palette, media: MEDIA, ...extra,
  }).problems;

test("I8: a lyric block lays out its whole line from its first frame; unsung tokens are hidden and not in the sidecar", () => {
  const p = plan();
  const s = frameState(p, 24); // "The" is sung; "city" and "wakes." are not yet
  const block = s.blocks[0];
  assert.deepEqual(block.tokens.map((t) => [t.text, t.drawn, t.shown]), [["The", true, 1], ["city", false, 0], ["wakes.", false, 0]]);
  assert.deepEqual(s.tokens, [{ word: 0, text: "The" }]);
  // Hidden tokens never take the accent.
  assert.ok(block.tokens.filter((t) => !t.drawn).every((t) => !t.accent));
});

test("I7: a coverline or masthead that cannot fit at its floor is refused, naming the shot", () => {
  const long = "The city WAKES-AND-EVERY-SINGLE-WINDOW-ON-THE-BLOCK-IS-LIT-UP";
  assert.equal(long.length, 61);
  const board = structuredClone(CHAPTER_BOARD) as typeof CHAPTER_BOARD;
  board.shots[1].type[0] = { line: 0, mode: "coverline", text: long, placement: "left" };
  assert.deepEqual(problemsOf(board), [`--board: "s002" type[0] coverline "${long}" does not fit one line at 56 px (16:9)`]);
  const mast = structuredClone(CHAPTER_BOARD) as typeof CHAPTER_BOARD;
  mast.shots[5].type[0].text = "HOLD THE LIGHTHOUSEKEEPERSDAUGHTERSWEDDINGANNOUNCEMENTSCOLUMNS";
  assert.deepEqual(problemsOf(mast, { vertical: true }), [
    `--board: "s006" type[0] masthead "HOLD THE LIGHTHOUSEKEEPERSDAUGHTERSWEDDINGANNOUNCEMENTSCOLUMNS" does not fit two lines at 97 px (9:16)`,
  ]);
  // The test chapter's own type fits both shapes.
  assert.deepEqual(problemsOf(CHAPTER_BOARD), []);
  assert.deepEqual(problemsOf(CHAPTER_BOARD, { vertical: true }), []);
});

test("9:16: a shot's devices step down together to fit the band above the picture, or are refused", () => {
  const p = plan(CHAPTER_BOARD, { vertical: true });
  assert.equal(p.shots[1].deviceScale, 1); // a label and a counter fit at full size
  const board = structuredClone(CHAPTER_BOARD) as typeof CHAPTER_BOARD;
  const chart = { kind: "chart", anchor: { slot: "right" }, params: { series: [1, 2, 3] }, key: "B", line: null };
  board.shots[1].devices.push(chart as never);
  const scaled = plan(board, { vertical: true });
  assert.ok(scaled.shots[1].deviceScale < 1 && scaled.shots[1].deviceScale >= 0.6, String(scaled.shots[1].deviceScale));
  assert.equal(frameState(scaled, 80).deviceScale, scaled.shots[1].deviceScale);
  // 16:9 is not stepped down.
  assert.equal(plan(board).shots[1].deviceScale, 1);
  board.shots[1].devices.push(chart as never, chart as never);
  assert.deepEqual(problemsOf(board, { vertical: true }), ['--board: "s002" devices need 1216 px above the 9:16 picture, the band has 518 (they would shrink under 60 percent)']);
});
