// The drawn-token record (R1). The composition draws a frame's lyric tokens from
// frameState(plan, frame).blocks, and the same call lists them in `.tokens`, word by word;
// film:chapter runs it over every frame in Node and writes `<chapter>.tokens.json`. One
// function, so the sidecar and the pixels cannot disagree about what a frame shows.
export { tokensSidecar, audioEvents, frameState } from "./plan.ts";
export type Sidecar = { fps: number; chapter: string; ramp: boolean; frames: { t: number; tokens: { word: number; text: string }[] }[] };
