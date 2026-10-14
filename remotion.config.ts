import { Config } from "@remotion/cli/config";

// The frame rate (30) is set by the compositions: FPS in src/remotion/Teaser.tsx.
Config.setCodec("h264");
Config.setConcurrency(2);
