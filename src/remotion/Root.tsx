import { Composition, registerRoot } from "remotion";
import { EXAMPLE_PROPS, FPS, Teaser, calculateTeaserMetadata, teaserFrames } from "./Teaser.tsx";

// Two compositions over one timeline: the 16:9 master and the 4:5 reframe. Each one's
// length comes from calculateMetadata over the props, so it always matches the cut script.
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
    </>
  );
}

registerRoot(RemotionRoot);
