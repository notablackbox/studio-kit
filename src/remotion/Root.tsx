import { Composition, registerRoot } from "remotion";
import { EXAMPLE_PROPS, FPS, Teaser, calculateTeaserMetadata, teaserFrames } from "./Teaser.tsx";
import { EXAMPLE_FILM_PROPS, FilmChapter, calculateFilmMetadata } from "./film/FilmChapter.tsx";
import { FilmChapterVertical } from "./film/FilmChapterVertical.tsx";
import { FILM_FPS } from "./film/plan.ts";

// Two compositions over one timeline: the 16:9 master and the 4:5 reframe. Each one's
// length comes from calculateMetadata over the props, so it always matches the cut script.
// The film engine's chapter (R5) beside them: FilmChapter at 1920x1080, FilmChapterVertical at
// 1080x1920, and FilmHistory, the chapter's two frames A then B in one page for film:history.
function RemotionRoot() {
  return (
    <>
      <Composition
        id="Teaser"
        component={Teaser}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={teaserFrames(EXAMPLE_PROPS.clips)}
        defaultProps={EXAMPLE_PROPS}
        calculateMetadata={calculateTeaserMetadata}
      />
      <Composition
        id="TeaserSocial"
        component={Teaser}
        width={1080}
        height={1350}
        fps={FPS}
        durationInFrames={teaserFrames(EXAMPLE_PROPS.clips)}
        defaultProps={EXAMPLE_PROPS}
        calculateMetadata={calculateTeaserMetadata}
      />
      <Composition
        id="FilmChapter"
        component={FilmChapter}
        width={1920}
        height={1080}
        fps={FILM_FPS}
        durationInFrames={FILM_FPS}
        defaultProps={EXAMPLE_FILM_PROPS}
        calculateMetadata={calculateFilmMetadata}
      />
      <Composition
        id="FilmChapterVertical"
        component={FilmChapterVertical}
        width={1080}
        height={1920}
        fps={FILM_FPS}
        durationInFrames={FILM_FPS}
        defaultProps={EXAMPLE_FILM_PROPS}
        calculateMetadata={calculateFilmMetadata}
      />
      <Composition
        id="FilmHistory"
        component={FilmChapter}
        width={1920}
        height={1080}
        fps={FILM_FPS}
        durationInFrames={2}
        defaultProps={{ ...EXAMPLE_FILM_PROPS, history: [0, 1] as [number, number] }}
        calculateMetadata={calculateFilmMetadata}
      />
    </>
  );
}

registerRoot(RemotionRoot);
