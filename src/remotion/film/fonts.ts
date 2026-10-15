import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

// The film's three faces, read from the brand's fonts (staged by film:chapter under
// `brand/fonts/` in the render's public folder), each under a family name of its own so a
// system font can never stand in: Anton for headlines, Inter for lyric text, IBM Plex Mono for
// chrome and readouts. No frame is taken before every face has loaded (as the Teaser does).

export const FACE = { headline: "FilmAnton", text: "FilmInter", mono: "FilmPlexMono" } as const;

export const FONT_FILES = [
  { family: FACE.headline, file: "Anton-Regular.ttf", weight: "400", format: "truetype" },
  { family: FACE.text, file: "Inter-Regular.woff2", weight: "400", format: "woff2" },
  { family: FACE.text, file: "Inter-SemiBold.woff2", weight: "600", format: "woff2" },
  { family: FACE.mono, file: "IBMPlexMono-Regular.ttf", weight: "400", format: "truetype" },
  { family: FACE.mono, file: "IBMPlexMono-Medium.ttf", weight: "500", format: "truetype" },
] as const;

export function useFilmFonts(): void {
  const [handle] = useState(() => delayRender("Loading the film's faces from brand/fonts"));
  useEffect(() => {
    const faces = FONT_FILES.map(
      (f) => new FontFace(f.family, `url("${staticFile(`brand/fonts/${f.file}`)}") format("${f.format}")`, { weight: f.weight }),
    );
    Promise.all(faces.map((face) => face.load())).then(
      (loaded) => {
        for (const face of loaded) document.fonts.add(face);
        continueRender(handle);
      },
      (error) => cancelRender(error),
    );
  }, [handle]);
}
