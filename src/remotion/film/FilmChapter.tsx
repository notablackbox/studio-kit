import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from "remotion";
import { Chrome } from "./chrome.tsx";
import { Devices } from "./devices/index.tsx";
import { useFilmFonts } from "./fonts.ts";
import { abs, filmLook, type FilmLook } from "./look.ts";
import { buildPlan, FILM_FPS, frameState, type Media, type Plan } from "./plan.ts";
import { Picture } from "./plates/Picture.tsx";
import { ditherClip } from "./transitions.ts";
import { TypeBlock } from "./type/index.tsx";

// FilmChapter (R5): one chapter of the music video, 24 fps, 1920x1080; FilmChapterVertical is
// the same timeline at 1080x1920 for film:reframe. The props are the chapter id and the paths
// film:chapter resolved: the board, the edit list, the analysis, the display text, the plates,
// clips and footage folders and the brand. A browser cannot read those paths, so film:chapter
// stages the files a chapter needs in the render's public folder (`in/`, `plates/`, `clips/`,
// `footage/`, `brand/`) and calculateMetadata reads them from there, builds the plan once and
// hands it to every frame. Each frame is frameState(plan, frame): a pure function of the frame
// number and the props.

export type FilmProps = {
  chapter: string;
  board: string;
  edl: string;
  words: string;
  beats: string;
  hits: string;
  display: string;
  plates: string;
  clips: string;
  footage: string | null;
  brand: string;
  ramp?: boolean; // false only under film:chapter's test-only --no-ramp
  history?: [number, number] | null; // FilmHistory: draw frame A, then frame B, in one page
  plan?: Plan;
};

export const EXAMPLE_FILM_PROPS: FilmProps = {
  chapter: "ch01",
  board: "/work/film/example/board/shots.json",
  edl: "/work/film/example/edit/edl.json",
  words: "/work/film/example/analysis/words.json",
  beats: "/work/film/example/analysis/beats.json",
  hits: "/work/film/example/analysis/hits.json",
  display: "/work/film/example/lyrics/display.txt",
  plates: "/work/film/example/plates",
  clips: "/work/film/example/clips",
  footage: "/work/film/example/footage",
  brand: "/opt/studio/brand",
};

async function staged(name: string): Promise<string> {
  const response = await fetch(staticFile(name));
  if (!response.ok) throw new Error(`${name} is not staged for this render`);
  return response.text();
}

export const calculateFilmMetadata: CalculateMetadataFunction<FilmProps> = async ({ props }) => {
  const [board, edl, words, beats, hits, display, palette, media] = await Promise.all(
    ["in/board.json", "in/edl.json", "in/words.json", "in/beats.json", "in/hits.json", "in/display.txt", "brand/palette.json", "in/media.json"].map(staged),
  );
  const { plan, problems } = buildPlan({
    chapter: props.chapter,
    board: JSON.parse(board),
    edl: JSON.parse(edl),
    words: JSON.parse(words),
    beats: JSON.parse(beats),
    hits: JSON.parse(hits),
    display,
    palette: JSON.parse(palette),
    media: JSON.parse(media) as Media,
    ramp: props.ramp !== false,
  });
  if (!plan) throw new Error(problems.join("; "));
  const frames = props.history ? 2 : Math.max(1, plan.to - plan.from);
  return { durationInFrames: frames, fps: FILM_FPS, props: { ...props, plan } };
};

function Frame({ plan, look, frame }: { plan: Plan; look: FilmLook; frame: number }) {
  const state = frameState(plan, frame);
  const { color } = look;
  const pictureBox = abs(look.picture);
  return (
    <AbsoluteFill style={{ backgroundColor: color.black, color: color.white, WebkitFontSmoothing: "antialiased", fontFeatureSettings: '"kern", "calt"' }}>
      <div style={pictureBox}>
        {state.under ? <Picture layer={state.under.layer} black={color.black} /> : null}
        <div style={{ position: "absolute", inset: 0, ...(state.dither !== null ? ditherClip(look.picture.w, look.picture.h, state.dither) : {}) }}>
          <Picture layer={state.layer} black={color.black} />
        </div>
      </div>
      {state.card > 0 ? <AbsoluteFill style={{ backgroundColor: color.black, opacity: state.card }} /> : null}
      {state.blocks.map((block, i) => (
        <TypeBlock key={`b${i}`} block={block} look={{ ...look, color: { ...color, accent: state.accent } }} />
      ))}
      <Devices devices={state.devices} look={{ ...look, color: { ...color, accent: state.accent } }} />
      {state.chrome ? <Chrome chrome={state.chrome} look={look} /> : null}
    </AbsoluteFill>
  );
}

export function FilmChapter(props: FilmProps) {
  useFilmFonts();
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  if (!props.plan) return null;
  const look = filmLook(width, height, props.plan.palette);
  // FilmHistory: composition frame 0 draws chapter frame A and frame 1 draws chapter frame B,
  // one after the other through the same components in the same page (film:history renders
  // with one tab), so anything a frame kept from the one before would show in B.
  const chapterFrame = props.history ? props.history[Math.min(1, Math.max(0, frame))] : frame;
  return <Frame plan={props.plan} look={look} frame={chapterFrame} />;
}

