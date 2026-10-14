import { useEffect, useState, type CSSProperties } from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { TransitionSeries } from "@remotion/transitions";
import palette from "../../brand/palette.json";
import { crossFade } from "./transitions.ts";
import { Opening } from "./cards/Opening.tsx";
import { LowerThird, captionBelowHeight } from "./cards/LowerThird.tsx";
import { Proof } from "./cards/Proof.tsx";
import { Closing } from "./cards/Closing.tsx";

// The one set of numbers. render.ts imports these for the length a cut script adds up to,
// and calculateMetadata below uses them for the composition's duration.
export const FPS = 30;
export const OPENING_FRAMES = 90;
export const PROOF_FRAMES = 90;
export const CLOSING_FRAMES = 120;
export const CROSSFADE_FRAMES = 12;

export type CutClip = { file: string; in: number; out: number; caption: string };
export type TeaserProps = {
  date: string;
  title: string;
  opening: { headline: string; sub: string };
  clips: CutClip[];
  proof: { line: string; source: string };
  closing: { line: string };
  posterFrame: number;
};

export const clipFrames = (clip: Pick<CutClip, "in" | "out">): number => Math.round((clip.out - clip.in) * FPS);

// The length a script adds up to: the clips' out minus in, plus the three cards, less one
// cross-fade per join. Each clip is counted in whole frames, as the composition plays it, so
// the gate in render.ts and the rendered master agree to the frame.
export function teaserFrames(clips: Pick<CutClip, "in" | "out">[]): number {
  const footage = clips.reduce((sum, clip) => sum + clipFrames(clip), 0);
  return OPENING_FRAMES + footage + PROOF_FRAMES + CLOSING_FRAMES - (clips.length + 2) * CROSSFADE_FRAMES;
}

export const scriptSeconds = (clips: Pick<CutClip, "in" | "out">[]): number => teaserFrames(clips) / FPS;

export const calculateTeaserMetadata: CalculateMetadataFunction<TeaserProps> = ({ props }) => ({
  durationInFrames: teaserFrames(props.clips),
  fps: FPS,
});

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-10-13" -> "13 October 2026".
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

// What every card is handed: the grid (u, the frame width over 1920, sets the margins), the
// type scale (t: type and the spaces between lines are given in 16:9 pixels and multiplied by
// t), and the palette. Colours come from brand/palette.json and nowhere else.
export type Look = {
  width: number;
  height: number;
  u: number;
  t: number;
  margin: number;
  social: boolean;
  font: string;
  color: { black: string; warmWhite: string; graphite: string; silver: string; productGreen: string };
  settle: (frame: number) => CSSProperties;
  fit: typeof fitFontSize;
  fitText: typeof fitText;
  wrap: CSSProperties;
};

// Text styles every card line shares: balanced lines, and a word too long for the line (an
// issue key, a URL) broken anywhere rather than run off the frame. Nothing is ever cut.
export const WRAP: CSSProperties = { textWrap: "balance", overflowWrap: "anywhere" };

// The largest size, from `max` down to `min` in 4 px steps, at which `text` is estimated to
// take at most `lines` lines of `width` px. The estimate wraps word by word with generous
// per-character advances for Inter SemiBold (capitals and W or M wider than lower case), so
// the real text takes no more lines than counted. The type never goes below `min`: text that
// still needs more lines there takes the lines it needs, and is never cut.
const SPACE_EM = 0.28;

function advanceEm(char: string): number {
  if ("WMwm@%".includes(char)) return 0.95;
  if ("iljtfrI.,:;!|'()[]-/ ".includes(char)) return 0.36;
  if (/[A-Z]/.test(char)) return 0.74;
  if (/[0-9]/.test(char)) return 0.64;
  if (/[a-z]/.test(char)) return 0.58;
  return 1.0;
}

export function fitFontSize(text: string, max: number, min: number, width: number, lines: number): number {
  return fitText(text, max, min, width, lines).size;
}

// The same fit, with the number of lines the text is estimated to take at that size.
export function fitText(
  text: string,
  max: number,
  min: number,
  width: number,
  lines: number,
): { size: number; lines: number } {
  const words = text.trim().split(/\s+/).map((word) => [...word].map(advanceEm));
  for (let size = max; size > min; size -= 4) {
    const taken = linesAt(words, width / size);
    if (taken <= lines) return { size, lines: taken };
  }
  return { size: min, lines: linesAt(words, width / min) };
}

// Lines a run of words takes on a line `room` em wide; a word wider than the line breaks anywhere.
function linesAt(words: number[][], room: number): number {
  let count = 1;
  let used = 0;
  for (const word of words) {
    const wordEm = word.reduce((sum, em) => sum + em, 0);
    if (used > 0 && used + SPACE_EM + wordEm <= room) {
      used += SPACE_EM + wordEm;
      continue;
    }
    if (used > 0) count += 1;
    used = 0;
    for (const em of word) {
      if (used > 0 && used + em > room) {
        count += 1;
        used = 0;
      }
      used += em;
    }
  }
  return count;
}

const FONT_FAMILY = "StudioInter";
const INTER_REGULAR = new URL("../../brand/fonts/Inter-Regular.woff2", import.meta.url).href;
const INTER_SEMIBOLD = new URL("../../brand/fonts/Inter-SemiBold.woff2", import.meta.url).href;

// The type on card text: a gentle opacity rise and a 3 percent scale settle, nothing else.
function settle(frame: number): CSSProperties {
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, 45], [1.03, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return { opacity, transform: `scale(${scale})`, transformOrigin: "left center" };
}

function useLook(): Look {
  const { width, height } = useVideoConfig();
  const u = width / 1920;
  const social = height > width;
  return {
    width,
    height,
    u,
    // 4:5 is watched on a phone: its type keeps the master's pixel sizes (headlines 72 to 112,
    // the caption 48) rather than shrinking with the narrower frame.
    t: social ? 1 : u,
    margin: 160 * u,
    social,
    font: FONT_FAMILY,
    color: {
      black: palette.black.hex,
      warmWhite: palette.warmWhite.hex,
      graphite: palette.graphite.hex,
      silver: palette.silver.hex,
      productGreen: palette.productGreen.hex,
    },
    settle,
    fit: fitFontSize,
    fitText,
    wrap: WRAP,
  };
}

// Inter Regular and SemiBold from brand/fonts, under a family name of their own so a
// system Inter can never stand in. No frame is taken before both faces have loaded.
function useBrandFonts(): void {
  const [handle] = useState(() => delayRender("Loading Inter from brand/fonts"));
  useEffect(() => {
    const faces = [
      new FontFace(FONT_FAMILY, `url("${INTER_REGULAR}") format("woff2")`, { weight: "400" }),
      new FontFace(FONT_FAMILY, `url("${INTER_SEMIBOLD}") format("woff2")`, { weight: "600" }),
    ];
    Promise.all(faces.map((face) => face.load())).then(
      (loaded) => {
        for (const face of loaded) document.fonts.add(face);
        continueRender(handle);
      },
      (error) => cancelRender(error),
    );
  }, [handle]);
}

function ClipScene({ clip, look }: { clip: CutClip; look: Look }) {
  const video = (
    <OffthreadVideo
      src={staticFile(clip.file)}
      trimBefore={Math.round(clip.in * FPS)}
      muted
      style={{ width: "100%", height: "100%", objectFit: look.social ? "contain" : "cover" }}
    />
  );
  if (!look.social) {
    return (
      <AbsoluteFill style={{ backgroundColor: look.color.black }}>
        {video}
        <LowerThird caption={clip.caption} look={look} />
      </AbsoluteFill>
    );
  }
  // 4:5: the clip at full frame width on black, nothing cropped, the caption beneath it on
  // the grid; the clip and its caption are centred together as one block.
  const clipHeight = (look.width * 9) / 16;
  const top = Math.round((look.height - clipHeight - captionBelowHeight(clip.caption, look)) / 2);
  return (
    <AbsoluteFill style={{ backgroundColor: look.color.black }}>
      <div style={{ position: "absolute", left: 0, top, width: look.width, height: clipHeight }}>{video}</div>
      <LowerThird caption={clip.caption} look={look} top={top + clipHeight} />
    </AbsoluteFill>
  );
}

export function Teaser(props: TeaserProps) {
  useBrandFonts();
  const look = useLook();
  const fade = crossFade(CROSSFADE_FRAMES);
  const scenes = [
    <TransitionSeries.Sequence key="opening" durationInFrames={OPENING_FRAMES}>
      <Opening headline={props.opening.headline} sub={props.opening.sub} look={look} />
    </TransitionSeries.Sequence>,
    ...props.clips.map((clip, i) => (
      <TransitionSeries.Sequence key={`clip-${i}`} durationInFrames={clipFrames(clip)}>
        <ClipScene clip={clip} look={look} />
      </TransitionSeries.Sequence>
    )),
    <TransitionSeries.Sequence key="proof" durationInFrames={PROOF_FRAMES}>
      <Proof line={props.proof.line} source={props.proof.source} look={look} />
    </TransitionSeries.Sequence>,
    <TransitionSeries.Sequence key="closing" durationInFrames={CLOSING_FRAMES}>
      <Closing line={props.closing.line} date={formatDate(props.date)} look={look} />
    </TransitionSeries.Sequence>,
  ];
  const timeline = scenes.flatMap((scene, i) =>
    i === 0 ? [scene] : [<TransitionSeries.Transition key={`fade-${i}`} {...fade} />, scene],
  );
  return (
    <AbsoluteFill
      style={{
        backgroundColor: look.color.black,
        color: look.color.warmWhite,
        fontFamily: `"${FONT_FAMILY}", sans-serif`,
        fontFeatureSettings: '"kern", "calt"',
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <TransitionSeries>{timeline}</TransitionSeries>
    </AbsoluteFill>
  );
}

// The example cut script from the contract, used only as the compositions' default props.
export const EXAMPLE_PROPS: TeaserProps = {
  date: "2026-10-13",
  title: "What shipped on 13 October",
  opening: { headline: "The run shows its receipt", sub: "13 October" },
  clips: [
    { file: "shot-01.mp4", in: 0, out: 15, caption: "Every step, as it ran" },
    { file: "shot-02.mp4", in: 0, out: 15, caption: "The board opens on today" },
    { file: "shot-03.mp4", in: 0, out: 15, caption: "Jobs, with the shortlist beside them" },
  ],
  proof: { line: "Merged this week", source: "notablackbox/nabb-fe#1234" },
  closing: { line: "Not a black box." },
  posterFrame: 90,
};
