# studio-kit

A small kit for the nabb Studio: it records a short walk through the product
with Playwright, cuts a 45 to 60 second teaser with Remotion, and turns a
changelog entry into a card for the site. It is cloned into `/opt/studio` in the
sandbox image and called through three npm scripts: `walk`, `render` and
`changelog`.

Exit codes, the same in every script: `0` done and report written; `2` refused
before any work (bad input, or `session rejected`); `1` anything unexpected.

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
read, or the first line holds no date.

## `walk`

Records the product with Chromium, one clip per shot.

| Flag | Meaning |
|---|---|
| `--shotlist <path>` | Required. The shot list. |
| `--out <dir>` | Required unless `--dry-run`. Clips and `walk-report.json` land here. |
| `--dry-run` | Validate the shot list against `routes.json` and exit. Prints `shot list ok: N shots` and exits 0, or one problem per line and exits 2. Opens no browser, reads no environment. |
| `--synthetic` | Reads no environment and no session, opens no browser. Writes one ffmpeg `testsrc` clip per shot, `dwell` seconds long, 1920x1080 at 30 fps. |
| `--only <n>` | Records shot `n` alone, on its route's `fallback`, and merges the result into the report already in `--out`. |

A shot list (`shotlist.json`) holds a `date` and one to twelve `shots`, each
with `n`, `surface`, `route`, `dwell` (3 to 20 seconds), `clicks` and `caption`
(1 to 60 characters). It is refused when it has no shot or more than 12, when an
`n` repeats, when a `route` is neither a `route` nor a `fallback` in
`routes.json`, when a `clicks` entry is not listed for that route, when a
`surface` is not the `surface` of the `routes.json` entry that owns the shot's
`route`, or when a caption is empty or over 60 characters (counted as Unicode
characters, not UTF-16 units). A selector the kit does not list is never
clicked.

`routes.json` lists the screens the walk may open: `surface`, `route`, `settle`
(the selector the walk waits for before the dwell starts), the `clicks` allowed
on that route and a `fallback` route. Its five surfaces are Office, Home, People,
Claws and Hiring. The selectors were checked against the nabb-fe source; they
are to be verified in a browser on the day the kit is pinned.

A real walk, in order:

1. Reads `NABB_WALK_URL`. Missing: prints `NABB_WALK_URL is not set`, exits 2. Not an `http:` or `https:` URL: prints `NABB_WALK_URL is not a URL`, exits 2, and leaves the session file in place.
2. Reads `$HOME/.studio/walk-session`, JSON `{"accessToken": "...", "expiresAt": <epoch seconds>}`. Absent, unparsable, missing a key or expired: prints `session rejected`, exits 2, writes no clip.
3. Deletes the session file, then launches Chromium. The token lives in memory only.
4. For each shot, a fresh context with a 1920x1080 viewport and a 1920x1080 video.
5. Signs the context in with two cookies, `access_token` and `refresh_token`, on the walk URL's host, both carrying the access token.
6. Opens the route, waits for `settle`, makes the listed clicks, holds for `dwell` seconds and keeps the video as `shot-NN.webm`.
7. A first navigation that lands on `/login` means the session is dead: prints `session rejected`, deletes any clip, exits 2.
8. A shot that fails is marked failed in the report and the walk goes on. The exit code is still 0: the report is the answer.

Every main-frame navigation, across redirects and for the whole life of a shot, is held to the walk URL's origin: one that leaves it is aborted and the shot fails with `route leaves the walk host`. Sub-resource requests to other origins are not touched.

`walk-report.json` holds `date`, `synthetic`, a `shots` list (`n`, `surface`,
`route`, `ok`, `file`, `seconds`, `status` of `recorded` or `failed`, `error`,
`usedFallback`), and the counts `recorded` and `failed`. `route` is the path
opened. `usedFallback` is true when that path is a fallback: under `--only`, or
when the shot names a path that is some entry's `fallback` and no entry's `route`.

## `render`

`--script <cutscript.json> --clips <dir> --out <dir>`, all required. The cut
script holds `date`, `title`, an `opening` (`headline`, `sub`), three to five
`clips` (`file`, `in`, `out`, `caption`), a `proof` (`line`, `source`), a
`closing` (`line`) and a `posterFrame`.

It is refused with exit 2, before any transcode and with no report or file
written, when there are fewer than 3 or more than 5 clips; when a `file` is not
a plain name inside `--clips` or does not exist there; when an `out` is not
after its `in`; or when the length adds up to under 45 or over 60 seconds. The
refusal prints the sum, for example `script runs 38.4 seconds, want 45 to 60`.

The length is the clips' `out` minus `in`, summed, plus the opening, proof and
closing cards (90, 90 and 120 frames at 30 fps), less one 12 frame cross-fade
for each join. Three whole 15 second clips run 45 + 10 - 2.0 = 53.0 seconds.

Then, each a named step in `render-report.json`: transcode every used `.webm`
to `.mp4` with ffmpeg; render `Teaser` to `teaser.mp4` (1920x1080, 30 fps,
h264); render `TeaserSocial` to `teaser-4x5.mp4` (1080x1350, the same timeline
with each clip at full frame width on black and the type beneath); render the
`posterFrame` still to `poster.png`; measure each output with ffprobe. A master
shorter than 45 or longer than 60 seconds fails the last step.
`render-report.json` is written once work has started, on success and on
failure (`ok: false`, exit 1); its `outputs.teaser.durationSeconds` is what the
sweep reads.

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
