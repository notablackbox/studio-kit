# studio-kit

A small kit for the nabb Studio: it records a short walk through the product
with Playwright, cuts a 45 to 60 second teaser with Remotion, and turns a
changelog entry into a card for the site. It is cloned into `/opt/studio` in the
sandbox image and called through three npm scripts: `walk`, `render` and
`changelog`.

Exit codes, the same in every script: `0` done and report written; `2` refused
before any work (bad input, or `session rejected`); `1` anything unexpected.
Every refusal is printed on stdout, one line per problem; stderr carries only
diagnostics. [Refusals](#refusals) lists every line each script can print.

The kit never prints a token, the walk URL, a cookie or the environment. A route
in any report is the path only. It writes only in the `--out` folder (or the
`--out` file), the system temporary folder and its own `node_modules`.

Path arguments are resolved against `INIT_CWD` when it is set (npm sets it to
the caller's directory under `npm --prefix /opt/studio run ...`), otherwise
against the current directory. `routes.json`, `brand/` and `src/` are always
found relative to the kit, never the current directory.

## Run it

Locally, with Node 20.6 or newer, ffmpeg on the path and Playwright's Chromium:

```bash
npm ci
npx remotion browser ensure
npm test
npm run changelog -- --in entry.md --out card.html
```

In the container the CI uses, which is the same image the sandbox builds from:

```bash
docker run --rm -v "$PWD":/kit -w /kit mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-noto-core fonts-noto-color-emoji && npm ci && npx remotion browser ensure && npm test'
```

In the sandbox the scripts are called as:

```bash
npm --prefix /opt/studio run walk -- --shotlist <path> --dry-run
npm --prefix /opt/studio run walk -- --shotlist <path> --out <dir> [--synthetic] [--only <n>]
npm --prefix /opt/studio run render -- --script <path> --clips <dir> --out <dir>
npm --prefix /opt/studio run changelog -- --in <file.md> --out <file.html>
```

## `changelog`

`--in <file.md> --out <file.html>`. Reads one entry whose first line is a
heading holding a date (`YYYY-MM-DD`, or `D Month YYYY` with an English month
name) and writes one card:

```html
<article class="changelog-card">
<h2>13 October 2026</h2>
<ul>
<li>One change per line between the heading and the last line</li>
</ul>
<p>The last line, the closing one.</p>
</article>
```

The entry is treated as text. A leading `#`, `-` or `*` is dropped and
everything else is HTML-escaped (`&`, `<`, `>`, `"`, `'`). Markdown inside a line
is not interpreted, so a link or an image arrives as the characters the entry
holds and nothing is fetched. The tags are `article`, `h2`, `ul`, `li` and `p`;
the only attribute is the article's `class`. There is no script, no remote asset
and no event handler, because a person pastes the card into the site.

Exit `2`, with no file written, when a flag is missing, the input cannot be
read, or the first line holds no date (the lines are under
[Refusals](#refusals)).

## `walk`

Records the product with Chromium, one clip per shot.

| Flag | Meaning |
|---|---|
| `--shotlist <path>` | Required. The shot list. |
| `--out <dir>` | Required unless `--dry-run`. Clips and `walk-report.json` land here. |
| `--dry-run` | Validate the shot list against `routes.json` and exit. Prints `shot list ok: N shots` and exits 0, or one problem per line and exits 2. Opens no browser, reads no environment. |
| `--synthetic` | Reads no environment and no session, opens no browser. Writes one ffmpeg `testsrc` clip per shot, `dwell` seconds long, 1920x1080 at 30 fps. |
| `--only <n>` | Records shot `n` alone, on its route's `fallback`, and merges the result into the report already in `--out`. |

A shot list (`shotlist.json`) holds a `date`, a real calendar date written
`YYYY-MM-DD` (the same check render makes), and one to twelve `shots`, each
with `n`, `surface`, `route`, `dwell` (3 to 20 seconds), `clicks` and `caption`
(1 to 60 characters). It is refused when the `date` is not a real `YYYY-MM-DD`
date, when it has no shot or more than 12, when an `n` repeats, when a `route` is neither a `route` nor a `fallback` in
`routes.json`, when a `clicks` entry is not listed for that route, when a
`surface` is not the `surface` of the `routes.json` entry that owns the shot's
`route`, or when a caption is empty or over 60 characters (counted as Unicode
characters, not UTF-16 units). A selector the kit does not list is never
clicked.

`routes.json` lists the screens the walk may open: `surface`, `route`, `settle`
(the selector the walk waits for before the dwell starts), the `clicks` allowed
on that route and a `fallback` route. Its five surfaces are Office, Home, People,
Claws and Hiring. The routes and selectors are read from nabb-fe's source; the
first live walk is the browser check, and `walk-report.json` names any shot that
fails (for example `settle selector not found`).

A real walk, in order:

1. Reads `NABB_WALK_URL`. Missing: prints `NABB_WALK_URL is not set`, exits 2. Not an `http:` or `https:` URL: prints `NABB_WALK_URL is not a URL`, exits 2, and leaves the session file in place.
2. Reads `$HOME/.studio/walk-session`, JSON `{"accessToken": "...", "expiresAt": <epoch seconds>}`. Absent, unparsable, missing a key or expired: prints `session rejected`, exits 2, writes no clip.
3. Deletes the session file, then launches Chromium. The token lives in memory only.
4. For each shot, a fresh context with a 1920x1080 viewport and a 1920x1080 video.
5. Signs the context in with two cookies, `access_token` and `refresh_token`, on the walk URL's host, both carrying the access token.
6. Opens the route, waits for `settle`, makes the listed clicks, holds for `dwell` seconds, then cuts the video with ffmpeg and keeps the cut as `shot-NN.webm`. Playwright's video starts with the page, so the raw recording holds a blank page, the navigation and the settle wait; the cut starts on the settled page, from the moment the settle selector resolved (measured against the page's creation, and a little late rather than early, so no blank frame survives), and ends with the dwell. It is re-encoded as VP8, 1920x1080 at 30 fps, as the synthetic clips are. A cut that fails fails the shot with `clip could not be trimmed`.
7. A shot, any shot, whose first navigation lands on `/login` (after redirects) means the session is dead: prints `session rejected`, deletes every clip this run wrote, writes no report, exits 2.
8. A shot that fails is marked failed in the report, its clip removed, and the walk goes on. The exit code is still 0: the report is the answer. A page that answers 400 or above fails with `page answered NNN`, one with no response with `page did not answer`.

Every main-frame navigation of the shot's page, across redirects and for the whole life of a shot, is held to the walk URL's origin: one that leaves it is aborted and the shot fails with `route leaves the walk host`. A popup (`window.open`, a `target=_blank` link) never loads a document: its first request, and every later one, is aborted before it leaves the browser; a popup aimed at another origin fails the shot the same way, and a popup's video is removed. Sub-resource requests to other origins are not touched.

Shot list values in a problem line are printed JSON-quoted, so a control character in them cannot start a line of its own: one problem is always one line.

`walk-report.json` holds `date`, `synthetic`, a `shots` list (`n`, `surface`,
`route`, `ok`, `file`, `seconds`, `status` of `recorded` or `failed`, `error`,
`usedFallback`), and the counts `recorded` and `failed`. `seconds` is the clip's
length as ffprobe measures it, rounded down to one decimal so it never claims
more than the file holds: on a real walk the clicks and the dwell, give or take
a frame or two; on a synthetic one the `dwell`. A failed
shot has `file` empty and `seconds` 0. `error` is one of `settle selector not
found`, `click target not found`, `page did not load`, `page did not answer`,
`page answered NNN`, `route leaves the walk host`, `clip could not be trimmed`,
`clip not written` or `shot failed`. `route` is the path
opened. `usedFallback` is true when that path is a fallback: under `--only`, or
when the shot names a path that is some entry's `fallback` and no entry's `route`.
The report is written to a fresh name in `--out` and renamed into place, so a
symlink at `walk-report.json` is replaced, never written through; `--only`
merges only a report that is a plain file.

## `render`

`--script <cutscript.json> --clips <dir> --out <dir>`, all required. The cut
script holds `date`, `title`, an `opening` (`headline`, `sub`), three to five
`clips` (`file`, `in`, `out`, `caption`), a `proof` (`line`, `source`), a
`closing` (`line`) and a `posterFrame`.

It is refused with exit 2, before any transcode and with no report or file
written, one line per problem, when there are fewer than 3 or more than 5
clips; when a `file` is not a plain name inside `--clips` (no `/`, no `\`, not
`.` or `..`, no control or line-breaking character) or does not exist there;
when an `in` is negative or an `out` is not after its `in`; or when the length
adds up to under 45 or over 60 seconds.
The length refusal prints the sum, for example
`script runs 38.4 seconds, want 45 to 60`. The rest of the shape is checked the
same way: `date` a real `YYYY-MM-DD`; the opening's `headline` and `sub`, the
proof's `line` and `source` and the closing's `line` not empty; each `caption`
1 to 60 characters, so the lower third takes at most two lines; the card text
within its limit, `opening.headline` at most 60 characters and `opening.sub`,
`proof.line`, `proof.source` and `closing.line` at most 80, each refused in one
line naming the field (`opening.headline runs 61 characters, want at most 60`);
each clip at least one second; `posterFrame` a whole frame inside the master; no
clip named like one of render's own outputs (`teaser.mp4`, `teaser-4x5.mp4`,
`poster.png`, `render-report.json`); and `--out` a folder (or not there yet)
that is neither `--clips` nor inside it. A `--clips` folder below `--out` is
fine (`--clips /work/raw/<date> --out /work`): render writes only its own fixed
names at the top of `--out`. Captions and card text are counted as Unicode characters (code points),
not UTF-16 units, so an emoji counts as one. Values from the script are printed
JSON-quoted, as walk prints them, so one problem is always one line.

The length is the clips' `out` minus `in`, summed, plus the opening, proof and
closing cards (90, 90 and 120 frames at 30 fps), less one 12 frame cross-fade
for each join. Three whole 15 second clips run 45 + 10 - 2.0 = 53.0 seconds;
the same clips cut to 5 seconds run 23.0 and are refused. Each clip is counted
in whole frames (`round((out - in) * 30)`), exactly as the composition plays
it, so a script the gate lets through renders the length it was counted at:
12.31, 12.31 and 12.38 second clips make 1349 frames (44.97 seconds) and are
refused. The refusal never names a value inside the range it refuses: under 45
rounds down (`script runs 44.9 seconds`), over 60 rounds up (`60.1`). The numbers are the
constants `src/remotion/Teaser.tsx` exports (`FPS`, `OPENING_FRAMES`,
`PROOF_FRAMES`, `CLOSING_FRAMES`, `CROSSFADE_FRAMES`); `render.ts` sums with
them and the compositions take their length from them through
`calculateMetadata`.

Then, each a named step in `render-report.json`:

1. `transcode`: every used clip to `.mp4` (h264, 30 fps) with ffmpeg, into a
   fresh folder in the system temp folder that Remotion is given as its
   `--public-dir`; the props file sits beside it. A clip shorter than the `out`
   asked of it fails here.
2. `render-teaser`: `npx remotion render` of `Teaser` to `teaser.mp4`
   (1920x1080, 30 fps, h264).
3. `render-teaser-4x5`: `TeaserSocial` to `teaser-4x5.mp4` (1080x1350, the same
   timeline with each clip at full frame width on black and the type beneath;
   nothing of the product is cropped).
4. `still-poster`: `npx remotion still` of frame `posterFrame` to `poster.png`.
5. `measure`: each output through ffprobe (duration, width, height, frame
   rate). A master shorter than 45 or longer than 60 seconds fails this step,
   and so does a reframe whose length is more than one frame off the master's.

Each child process has a time limit (a render 15 minutes; ffmpeg, ffprobe and
the still 5 minutes); running past it fails the step. A child runs in a session
of its own, and when it times out, fails or ends, the kit kills everything it
started (Remotion's node process, Chromium in its own session, the compositor)
and waits until none of it runs before the step reports, so nothing keeps
burning CPU or writes into `--out` after a failure. A child and everything it
starts carry a fresh random marker in their environment, which is how the kit
finds them, Chromium in its own session and a process whose parent has exited
included; the marker is never printed. The temp folder is removed at the end.

In `--out` the kit adds the three outputs (`teaser.mp4`, `teaser-4x5.mp4`,
`poster.png`) and `render-report.json`, and nothing else; anything else already
in the folder is left as it is. Before rendering it removes any earlier output
of those names (a symlink at one of them is removed, never followed), and the
report is written to a fresh name and renamed into place, so it never writes
through a symlink. On failure it removes any output it wrote and leaves the
report, with `ok: false`, the failed step's `error` and empty `outputs`; the
exit code is 1. The report is written once work has started, on success and on
failure:

```json
{
  "ok": true,
  "date": "2026-10-13",
  "steps": [{ "name": "transcode", "ok": true, "error": "" }],
  "outputs": {
    "teaser": { "file": "teaser.mp4", "durationSeconds": 53.0, "width": 1920, "height": 1080, "fps": 30 },
    "teaser4x5": { "file": "teaser-4x5.mp4", "durationSeconds": 53.0, "width": 1080, "height": 1350, "fps": 30 },
    "poster": { "file": "poster.png", "width": 1920, "height": 1080 }
  },
  "clips": ["shot-01.webm", "shot-02.webm", "shot-03.webm"]
}
```

`clips` lists the files the script used. The sweep reads
`outputs.teaser.durationSeconds`. Remotion's OffthreadVideo frame cache is held
to 512 MB (its default is half the free memory, which ran a 6 GB box out of
memory next to Chromium and the encoder).

The film, in `src/remotion/`: an opening card (headline and sub), the clips with
a lower third (one line, or two balanced lines when the caption is long; never
cut short), a proof card (line and source), and a closing card with
the stacked mark and wordmark, the closing line and the date (`13 October
2026`). One 12 frame cross-fade between each. In the 4:5 reframe the type keeps
the master's pixel sizes (headlines 72 to 112 px, the caption 48 px), and each
clip and its caption (room for two lines) are centred together as one block.
A long opening headline or proof line takes up to three balanced lines, the
type stepping down to fit them but never below 72 px; text that still needs
more lines at 72 px takes them. No card text is cut or ended with an ellipsis,
and a word too long for its line (an issue key, a URL) breaks anywhere rather
than run off the frame. Black ground, warm white type,
silver for the supporting lines, product green only as a thin rule and a dot;
Inter Regular and SemiBold from `brand/fonts`, loaded before any frame is
taken; colours from `brand/palette.json` only; the brand SVGs shown as they
are.

## Refusals

Every line below is printed on stdout and ends the script with exit `2`, with
no clip, card, output or report written. `N`, `X` and the quoted values stand
for what the input held; a value from the input is printed JSON-quoted.

`walk`:

- `walk: --shotlist <path> is required`
- `walk: --out <dir> is required unless --dry-run`
- `walk: --only wants a shot number`
- `walk: ...` with the argument parser's own words, for an unknown flag or a
  flag missing its value
- `shot list cannot be read as JSON`
- one line per problem in the shot list: `shot list is not a JSON object`,
  `date must be a real date written YYYY-MM-DD`, `shots is not a list`,
  `shot list has no shots`, `shot list has N shots, at most 12`,
  `shot N: not an object`, `shot N: n is not a positive whole number`,
  `shot N: n repeats`, `shot N: surface is missing`,
  `shot N: dwell must be a number from 3 to 20`,
  `shot N: caption must be 1 to 60 characters`, `shot N: route is missing`,
  `shot N: route "..." is not in routes.json`,
  `shot N: surface "..." does not match "..." for route "..."`,
  `shot N: clicks must be a list of selectors`,
  `shot N: click "..." is not listed for "..."` (a shot with no whole-number
  `n` is named `shot at position N`)
- `shot N is not in the shot list` (`--only`)
- `NABB_WALK_URL is not set`
- `NABB_WALK_URL is not a URL`
- `session rejected`

`render`:

- `render: --script <path>, --clips <dir> and --out <dir> are required`
- `render: ...` with the argument parser's own words
- `cut script cannot be read as JSON`
- one line per problem in the cut script: `cut script is not a JSON object`,
  `date must be a real date written YYYY-MM-DD`, `title is missing`,
  `opening needs a headline and a sub`, `proof needs a line and a source`,
  `closing needs a line`,
  `opening.headline runs N characters, want at most 60`,
  `opening.sub runs N characters, want at most 80` (and the same for
  `proof.line`, `proof.source` and `closing.line`), `clips is not a list`,
  `--clips is not a folder`, `script has N clips, want 3 to 5`,
  `clip N: not an object`,
  `clip N: "..." is not a plain file name inside --clips`,
  `clip N: "..." is a name render writes in --out`,
  `clip N: "..." is not in --clips`,
  `clip N: in must be a number of seconds, 0 or more`,
  `clip N: out must be after in`,
  `clip N: runs X seconds, want at least 1` (a clip under one second),
  `clip N: caption must be 1 to 60 characters`,
  `script runs X seconds, want 45 to 60`,
  `posterFrame must be a whole frame from 0 to N`
- `--out is not a folder`
- `--out must not be the --clips folder or inside it`

`changelog`:

- `changelog: --in <file.md> and --out <file.html> are both required`
- `changelog: ...` with the argument parser's own words
- `changelog: cannot read the --in file`
- `changelog: the first line holds no date`

Exit `1`, on stderr: `walk: the session file could not be removed`,
`walk: unexpected failure`, `render: unexpected failure` (the report could not
be written) and `changelog: unexpected failure`. A render step that fails exits
`1` too, with the step's `error` in `render-report.json`.

## Brand sources

Nothing is redrawn. The files come from nabb-fe `origin/main`.

- R1, marks. `brand/wordmark-dark.svg` and `brand/wordmark-light.svg` are byte
  copies of `public/icons/brand/nabb-wordmark-dark.svg` and
  `nabb-wordmark-light.svg`. `brand/mark.svg` is a byte copy of
  `public/icons/brand/nabb-mark-dark.svg`, the knockout mark for dark grounds.
  "dark" means "for dark backgrounds" (white ink). Where a card shows mark and
  wordmark together it follows `nabb-logo-stacked-dark.svg`: the mark on top,
  the wordmark below, in a 231.85 by 226 box.
- R2, palette. `brand/palette.json` holds five colours with the token each came
  from: black `#0a0a0a`, warm white `#f5f5f7`, graphite `#2c2c2e`, silver
  `#e7e7ec` and product green `#34c759`. The product's UI accent is blue; green
  is the accent only in the teaser.
- R3, fonts. `brand/fonts/Inter-Regular.woff2` and `Inter-SemiBold.woff2` come
  from the `web/` folder of the official Inter v4.1 release, with the licence
  in `brand/fonts/OFL.txt`.
  - Release: https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
  - sha256 of the zip: `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`

## Licences

- The kit is MIT (see `LICENSE`).
- Inter is licensed under the SIL Open Font License 1.1. The licence travels
  with the fonts in `brand/fonts/OFL.txt`.
- Remotion is not MIT. Its free licence covers individuals and for-profit
  companies of up to 3 employees; a larger company needs a Remotion company
  licence (https://www.remotion.dev/license). Whether nabb needs one is open and
  is decided before the claw pins a release.
