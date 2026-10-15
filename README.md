# studio-kit

A small kit for the nabb Studio: it records a short walk through the product
with Playwright, cuts a 45 to 60 second teaser with Remotion, and turns a
changelog entry into a card for the site. It is cloned into `/opt/studio` in the
sandbox image and called through three npm scripts: `walk`, `render` and
`changelog`. Since v0.2.0 it also carries the film engine, the `film:*` commands
that make a music video by anabology's method ([film](#film)).

Exit codes, the same in every script: `0` done and report written; `2` refused
before any work (bad input, or `session rejected`); `3` checked and failed (the
film checks only); `1` anything unexpected.
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

The film commands also want Python 3 with the pinned CPU wheels of
`src/film/py/requirements.txt`, espeak-ng and sox (for the test song), and the
model weights in `$FILM_MODELS` ([film](#film)). In the container the CI uses,
which is the same image the sandbox builds from, with the same steps the CI runs
([Test image and CI](#test-image-and-ci) lists them and the times):

```bash
docker run --rm -v "$PWD":/kit -w /kit mcr.microsoft.com/playwright:v1.63.0-noble sh -c '
  apt-get update &&
  apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk sox espeak-ng python3 python3-pip python3-venv &&
  python3 -m venv /opt/film-venv && export PATH=/opt/film-venv/bin:$PATH &&
  pip install $(grep -E "^(torch|torchaudio|torchvision)==" src/film/py/requirements.txt) --index-url https://download.pytorch.org/whl/cpu &&
  pip install -r src/film/py/requirements.txt &&
  python3 -I src/film/py/film_py/models.py --dest /opt/models &&
  npm ci && npx remotion browser ensure && npm test'
```

In the sandbox the scripts are called as:

```bash
npm --prefix /opt/studio run walk -- --shotlist <path> --dry-run
npm --prefix /opt/studio run walk -- --shotlist <path> --out <dir> [--synthetic] [--only <n>]
npm --prefix /opt/studio run render -- --script <path> --clips <dir> --out <dir>
npm --prefix /opt/studio run changelog -- --in <file.md> --out <file.html>
npm --prefix /opt/studio run film:status -- --status <status.json> [--set field=value ...] [--out <dir>]
npm --prefix /opt/studio run film:score -- --lyrics <lyrics.txt> --out <dir>
npm --prefix /opt/studio run film:stems -- --in <song.wav> --out <dir>
npm --prefix /opt/studio run film:beats -- --drums <drums.wav> --out <dir> [--lyrics <lyrics.txt> [--words <words.json>]] [--downbeat-phase N] [--tempo-range low,high]
npm --prefix /opt/studio run film:words -- --vocals <vocals.wav> --lyrics <lyrics.txt> --out <dir> [--display <display.txt>] [--expect <words.json>] [--min-conf X]
npm --prefix /opt/studio run film:hits -- --stems <dir> --mix <song.wav> --out <dir> [--beats <beats.json>]
npm --prefix /opt/studio run film:window -- --vocals <vocals.wav> --words <words.json> --song-t0 <s> --duration <s> --out <dir> [--from N --to N] [--name <id>] [--allow-short (tests only)]
npm --prefix /opt/studio run film:audit -- --board <shots.json> --beats <beats.json> --words <words.json> --hits <hits.json> --display <display.txt> --out <dir> [--lead-share 0.7] [--motion-seconds N] [--motion-clips N] [--taboo word,word] [--hooks "A|B|C"] [--defer provenance] [--walk-report <walk-report.json>] [--recordings <recordings.json>]
npm --prefix /opt/studio run film:sheet -- --board <shots.json> --plates <dir> --out <dir>
npm --prefix /opt/studio run film:depth -- --plate <plate.png> --out <dir>
npm --prefix /opt/studio run film:edl -- --board <shots.json> --clips <dir> --words <words.json> --out <dir>
npm --prefix /opt/studio run film:request -- --clip <clips/W01.json> --provider openrouter|higgsfield --ledger <ledger.jsonl> --out <dir> --start-artifact <id> [--window-artifact <id>] [--resolution 720p] [--rate-per-second X]
npm --prefix /opt/studio run film:request -- --image <slot.json> --provider openrouter --ledger <ledger.jsonl> --out <dir> [--rate-per-image X]
npm --prefix /opt/studio run film:ledger -- --ledger <ledger.jsonl> --out <dir> --asked <request.json> [--meta <request.meta.json>] | --polled <key> | --delivered <key> --file <path> | --declined <key> | --failed <key> | --check <reference> [--figures <json>] [--reason <text>]
npm --prefix /opt/studio run film:sync -- --take <take.mp4> --window <window.wav> --beats <beats.json> --song-t0 <s> --out <dir>
npm --prefix /opt/studio run film:chapter -- --board <shots.json> --edl <edl.json> --words <words.json> --beats <beats.json> --hits <hits.json> --display <display.txt> --plates <dir> --clips <dir> [--footage <dir>] [--brand <dir>] --chapter <id> --out <dir> [--range t0:t1] [--vertical] [--no-ramp (FILM_TEST=1 only)]
npm --prefix /opt/studio run film:gate -- --tokens <chapter.tokens.json> --words <words.json> --display <display.txt> --out <dir>
npm --prefix /opt/studio run film:history -- <film:chapter's flags, no --range> --frames A,B [--test-leak (FILM_TEST=1 only)]
npm --prefix /opt/studio run film:flash -- --video <mp4> --out <dir>
npm --prefix /opt/studio run film:mix -- --master <song.wav> --events <ch01.audio.json> [<ch02.audio.json> ...] --vocals <vocals.wav> --sounds <dir> --out <dir>
npm --prefix /opt/studio run film:encode -- --chapters <ch01.mp4> [<ch02.mp4> ...] --mix <mix.wav> --out <dir> [--allow-unramped]
npm --prefix /opt/studio run film:reframe -- <film:chapter's flags> [--aspect 9:16]
npm --prefix /opt/studio run film:captions -- --words <words.json> --display <display.txt> --out <dir> [--video <mp4>] [--brand <dir>]
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
merges only a report that is a plain file. Clips are written the same way: each
is encoded under a fresh random name in `--out`, then whatever sits at
`shot-NN.webm` is removed (a link, never its target) and the clip renamed into
place.

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
that is neither `--clips` nor inside it, and whose nearest existing ancestor is
a folder (a path under a file, or a dangling symlink, is refused with `--out is
not a folder`; a `--clips` like that is `--clips is not a folder`). A `--clips` folder below `--out` is
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
the master's pixel sizes (headlines 72 to 112 px, the caption 48 px). A caption
of wide glyphs (W, CJK) steps down until it fits two lines, never below 32 px;
60 such characters still take three lines at 32 px in 4:5, and the space kept
beneath the clip grows to hold them, so the block stays centred. Each
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

## film

The film engine: commands that take a song from a scored lyric to a delivered
music video by anabology's method (claudia.gallery's wiki). Each is
`npm --prefix /opt/studio run film:<name> -- <flags>`, declared in
`package.json` as `tsx src/film/<name>.ts`.

The contract, the same for every film command:

- Exit `0`: done, and `<name>-report.json` written in `--out` (or beside the
  file the command names), holding `ok`, the `inputs` it used and the `outputs`
  it produced.
- Exit `2`: refused before any work, one line per problem on stdout, nothing
  written. A model the command needs that is not in `$FILM_MODELS` is a refusal:
  `model depth is not in "/opt/models" (run python3 -I src/film/py/film_py/models.py --dest "/opt/models")`,
  the folder JSON-quoted.
- Exit `3`: checked and failed, one line per failure on stdout, the report
  written.
- Exit `1`: anything unexpected, one short line on stderr in the kit's own words
  (`film:<name>: ...`), never a stack trace and nothing on stdout.
- Paths resolve against `INIT_CWD`, else the current directory; the kit finds
  its own files from its own place. A command writes only in `--out` (or the
  file it names), the system temp folder and `node_modules`. A value from the
  input in a printed line is JSON-quoted, as walk and render print them, so one
  problem is always one line. Nothing spends money or holds a key.

The audio and vision work is Python, run as `python3 -I -m film_py.<module>`
with the kit's `src/film/py` put first on the path (`-I` drops the current
folder and every `PYTHON*` variable, so the kit puts back exactly its own
folder; `-B` keeps it from writing bytecode beside the kit's sources;
`FILM_PYTHON` names another interpreter). It runs through render's
family-kill runner, with a time limit. A module prints one JSON document and
exits 0, or prints refusal lines and exits 2; anything else is exit 1
(`FILM_DEBUG=1` shows the module's own stderr). Its dependencies are CPU only
and pinned in `src/film/py/requirements.txt`: torch, torchaudio and
torchvision come first, from PyTorch's CPU index, then the rest.

The model weights are downloaded once, at image build, into `$FILM_MODELS`
(default `/opt/models`) by
`python3 -I src/film/py/film_py/models.py --dest /opt/models` (`--only depth,mms_fa`
for a subset): Depth Anything V2 Small (`depth-anything/Depth-Anything-V2-Small-hf`
through transformers, at a pinned revision), torchaudio's `MMS_FA` aligner,
demucs `htdemucs` and faster-whisper `tiny` (`Systran/faster-whisper-tiny`, at a
pinned revision). None needs a token. `models.json` there lists each model's
source, revision, files, sizes, sha256 and download time; a model that could
not be fetched is listed as `missing` with the reason, and nothing stands in for
it. A model already in the folder (its entry's files all there, or its expected
files found without an entry) is listed as `present` and left alone: it is not
downloaded again, and a run that cannot reach the network never turns it into
`missing`.

The environment the film commands read:

| Variable | Meaning |
|---|---|
| `FILM_MODELS` | The models folder (default `/opt/models`). A command that needs a model absent from it refuses with exit 2. |
| `FILM_PYTHON` | The interpreter the Python side runs with (default `python3`, the venv's when the venv is first on the path). |
| `FILM_DEBUG=1` | Shows the Python module's own stderr tail, and Remotion's, after an exit 1. |
| `FILM_TEST=1` | Unlocks the test-only flags `film:chapter --no-ramp` and `film:history --test-leak`; without it they are refused. The kit's tests set it; a production run never does. |

The commands, in the order of a production, with what each writes in `--out`
and the exit codes it can end with (every one can also end with `1`):

| Command | Writes | Exits |
|---|---|---|
| `film:status` | `status.json` (with `--set`), `status-report.json` | 0, 2 |
| `film:score` | `score-report.json` | 0, 2 |
| `film:stems` | `stems/vocals.wav`, `drums.wav`, `bass.wav`, `other.wav`, `stems-report.json` | 0, 2 |
| `film:beats` | `beats.json`, `beats-report.json` | 0, 2, 3 |
| `film:words` | `words.json`, `words-report.json` | 0, 2, 3 |
| `film:hits` | `hits.json`, `hits-report.json` | 0, 2 |
| `film:window` | `<name>.wav`, `<name>.mp3`, `window-report.json` | 0, 2, 3 |
| `film:audit` | `audit-report.json` | 0, 2, 3 |
| `film:sheet` | `sheet.pdf`, `sheet.html`, `sheet-report.json` | 0, 2 |
| `film:depth` | `<plate>.depth.png`, `.near.png`, `.mid.png`, `.far.png`, `.boxes.json`, `depth-report.json` | 0, 2 |
| `film:edl` | `edl.json`, `edl-report.json` | 0, 2, 3 |
| `film:request` | `<id>.request.json`, `<id>.request.meta.json`, `request-report.json` | 0, 2 |
| `film:ledger` | one row appended to the ledger, `ledger-report.json` | 0, 2 |
| `film:sync` | `<take>-sync.png`, `sync-report.json` | 0, 2, 3 |
| `film:chapter` | `<chapter>.mp4`, `<chapter>.tokens.json`, `<chapter>.audio.json`, `chapter-report.json` | 0, 2 |
| `film:gate` | `gate-report.json` | 0, 2, 3 |
| `film:history` | `history-<B>.png`, `history-<A>-then-<B>.png`, `history-report.json` | 0, 2, 3 |
| `film:flash` | `flash-report.json` | 0, 2, 3 |
| `film:mix` | `mix.wav`, `mix-report.json` | 0, 2, 3 |
| `film:encode` | `master.mp4`, `review.mp4`, `encode-report.json` | 0, 2 |
| `film:reframe` | `<chapter>.9x16.mp4`, `<chapter>.9x16.tokens.json`, `<chapter>.9x16.audio.json`, `reframe-report.json` | 0, 2 |
| `film:captions` | `captions.srt`, `captioned.mp4` (with `--video`), `captions-report.json` | 0, 2 |

Each command's flags are in the sandbox calls under [Run it](#run-it), its
work in its section below, and every line it can print under
[Refusals](#refusals).

### `film:status`

`--status <status.json>` required; `--out <dir>` (default: the folder of the
status file); `--set field=value ...`. Validates a production's control file
against schema version 1, prints it and exits 0, or names the first wrong field
in one line and exits 2:

```json
{
  "version": 1,
  "stage": "board",
  "step": "audit",
  "awaiting": { "kind": "ask", "id": "board-approval" },
  "expects": [{ "key": "approve", "name": "Approve the board" }],
  "sandbox_id": "sbx-0001",
  "updated_at": "2026-10-15T08:00:00.000Z"
}
```

`stage` is one of `brief`, `song`, `listen`, `cast`, `board`, `plates`,
`footage`, `motion`, `build`, `cut`, `deliver`, `delivered`; `step` and
`sandbox_id` non-empty strings; `awaiting` null or `{kind: "ask" | "files", id}`;
`expects` a list of `{key, name}`; `updated_at` a UTC time. The fields are
checked in that order, each missing then wrong, then any field the schema does
not have, so a partial file, an older or newer `version` and an unknown field
are all refused with the first one named.

`--set stage=listen step=beats` (pairs after the first may stand alone, and
`--set` may repeat) changes those fields, sets `updated_at` to now (always
later than the time it replaces) and writes the file to a fresh name renamed
into place. `awaiting` and `expects` take JSON (`awaiting=null`,
`expects=[{"key":"master","name":"The master WAV"}]`). `version` and
`updated_at` cannot be set; neither can a field the schema does not have. The
result is validated as a whole before anything is written. The new file keeps
the old one's permissions, and if the report cannot be written afterwards the
old text is put back before the exit 1, so a failed run never leaves a changed
`status.json`.

`status-report.json`: `ok`, `inputs` (`status`, the `set` pairs), `outputs`
(`status`, the file when it was written, else null; `report`) and the `status`.
The status file cannot be the report itself: a `--status` that resolves to
`status-report.json` in `--out` (or beside it, with no `--out`) is refused,
exit 2, before anything is written.

### `film:score`

`--lyrics <lyrics.txt> --out <dir>`, both required. Scores a lyric sheet before
any take is spent, after the song wiki's scorer. Section cues in square
brackets (`[Verse 1 - spoken, deadpan]`) are skipped and name the section and
its delivery (`spoken`, `sung` or `chant` from the cue's whole words, so
`rising` is not `sing` and `rap,` is `rap`; otherwise a verse is spoken and the
rest sung). Per line, `score-report.json` holds the
words with their syllables, stresses (`1` primary, `2` secondary, `0` weak) and
`source` (`cmudict`, the bundled CMU dictionary; `fallback`, a letter-group
count for a word it lacks; `letters`, an acronym said letter by letter;
`digits`), the line's `syllables` and `stresses`, a `scansion` and an
`assonance` score from 0 to 100, its `end_sound` and the line it rings with
(`partner`). Per section and for the sheet, `scansion` and `assonance`. The
scores are a diagnostic, never a gate: scansion spreads the line over Suno's
two-bar slot and weighs stresses on the beat, their spacing, the length for
the delivery and the line's shape; assonance is each line end's best rhyme,
slant rhyme or shared final consonants within four lines, plus the stressed
vowels echoed inside the line.

`lint`, also printed on stdout after a one-line summary, one line each: a
spoken line outside 10 to 13 syllables (`line 9: spoken line of 5 syllables,
want 10 to 13`), a number in digits (`line 9: digit in "3": spell numbers
out`), an all-caps acronym (`line 10: all-caps "AGI": spell an acronym out ("A G
I")`), and a sheet over about 3,000 characters. Lint never changes the exit
code.

### Listening: `film:stems`, `film:beats`, `film:words`, `film:hits`, `film:window`

The analysis of a take, after the toolkit wiki's items 4 to 8 and 14. The files
they write have the formats wiki's shapes (`words.json`, `beats.json`,
`hits.json`); times are seconds of song time. Measured on the test song in the
kit's container (4 CPUs): stems 9 to 11 s, words 6 to 8 s, beats, hits and
window 1 to 2 s each.

`film:stems --in <song.wav> --out <dir>`: demucs `htdemucs` on the CPU, all four
sources, never two-stem mode. Writes `<dir>/stems/vocals.wav`, `drums.wav`,
`bass.wav` and `other.wav` (16-bit, 44.1 kHz, the input's channels) as one unit:
the four are written into a fresh staging folder in `--out` and renamed into place as
`stems/`, an earlier `stems/` (or a link there) renamed aside first and then removed,
so a failed run leaves none of its stems and never mixes old and new. `stems-report.json` records
the model, the seconds taken and any samples clipped. The vocal stem feeds
`film:words` and `film:window`, the drum stem `film:beats` and `film:hits`, bass
and other the impacts and risers.

`film:beats --drums <drums.wav> --out <dir>`: the beat map, never one BPM. The
spectral flux of the drum stem below 5 kHz every 4 ms (the grid goes on the kick
and snare, not the hats); a local tempo per 20 s window every 5 s, in BPM steps
of 0.05 and phase steps of 4 ms, inside `--tempo-range` (default `70,180`; pin it
when the map locks onto half or double time); with five windows or more the
weakest fifth is dropped and the curve smoothed. Beats are stepped along the
curve from the strongest window and each is snapped to a drum onset within
30 ms. Downbeats by the kick vote: per block of 32 beats, the phase with the
most 30 to 150 Hz onset energy; a block whose two best phases are within
10 percent abstains (a kick on 1 and 3 ties), and when all abstain the song's
first kick decides (`downbeat_method: "kick"`). `--downbeat-phase N` (0 to 3, the
index in `beats` of the first downbeat) sets them by hand (`"manual"`).
`tempo` is `[{t, bpm}]`, one per window. Sections: with `--lyrics`, one per
`[tag]` of the sheet. With `--words` too, each starts on the downbeat its first
word belongs to (a word under 0.8 s before a downbeat is its pickup) and is
`source: "lyrics-tag"` (the first starts at 0); without words the bars are
shared evenly in the tags' order, named by the tags but `"heuristic"`. A tag
with no lyric line of its own is merged into the next tag (the last ones into
the one before), and a tag that would start on the same downbeat as the one
before is merged into it, each with a line in `section_notes` of the report
(`[Intro] has no lyric line of its own: merged into Verse`), so no section is
ever empty. Without a sheet, one section (`"heuristic"`). Each section has `t0`, `t1`, `bar0`, `bar1`
and an `energy` (the drums' RMS against the loudest second, 0 to 1).
A silent drum stem (the onset strength, before normalising, peaks under 1.0:
digital silence, dither, a drum hit under about -70 dBFS) has no grid to find,
and any tempo would be arbitrary: it is checked and failed, exit 3,
`beats: the drum stem is silent (no onsets)`, with `beats-report.json` written
(`ok` false, `onset_peak`, `onset_floor`) and no `beats.json`.

`film:words --vocals <vocals.wav> --lyrics <lyrics.txt> --out <dir>`: a time for
every sung word. The sheet's words (tag and blank lines skipped, the lyric
files' one parser) are romanised to the MMS_FA dictionary (a to z and the
apostrophe, accents dropped, digits spelled out) and force-aligned on the vocal
stem at 16 kHz with torchaudio's wav2vec2 `MMS_FA` (30 s chunks with 2 s of
context). Each word's edges are then moved to the stem's energy: out from its
loudest frame through frames at 5 percent of that peak, bridging closures under
80 ms, never into the next word, at most 0.25 s from where the aligner put it
(the aligner lets a last consonant run on into silence). A word whose `conf` is
under `--min-conf` (default 0.5; it tunes the fallback only, never the gate) falls back, as the wiki merges them: to
faster-whisper `tiny`'s word with the same text heard between its placed
neighbours (`src: "whisper"`, its edges refined the same way), else to an even
share of the gap between two placed words of its line (`"interp"`), else it
keeps the aligner's time. `words.json` holds `words` (`i`, `w`, `line`, `t0`,
`t1`, `conf`, `src`), `lines` (`line`, `text`, `t0`, `t1`) and `gaps` (2 s or
more between two words, or after the last word to the end, each with the index
of the word it follows in `after_word`; the silence before the first word is not a gap).
The check: with `--expect` (a `words.json`, or the test song's `truth.json`), at
least 90 percent of the words must start and end within 0.10 s of the expected
times; without it, at least 90 percent must have a `conf` of 0.5 or more (fixed:
`--min-conf 0` cannot pass a weak alignment).
Otherwise exit `3`, `words.json` and the report still written, and one line per
failure: `words: 8 of 12 within 0.10 s of the expected times, want at least 90 percent`
(or `words: 5 of 12 with confidence 0.5 or more, want at least 90 percent`),
then `word 3 "we": starts +0.13 s, ends +0.00 s off` for each word off (up to 20).
The ear check, in `words-report.json` (`ear_check`, at most five spots, most
urgent first; `flags` holds them all) and printed as `ear check: ...` lines:
`letters` (an all-caps token sung letter by letter), `order` (a word starting over 0.05 s before the one ahead), `gap` (over
1 s between two words of a line), `verylow` (`conf` under 0.1), `length` (a word
over 1.2 s, or over three times its line's median), `lowconf` (`conf` under 0.3,
or a time from the fallback). With `--display`, each display line must consume
exactly its lyric line's words (`TEXT|n` shows TEXT over n words, n defaults to
1, `|0` rides on the next token), else it is refused before any work. A lyric
line with no letters (`...`) is refused too, one line each, never dropped: the
display, the board and the chapter engine count lines by the sheet, so a
dropped line would move every line after it.

`film:hits --stems <dir> --mix <song.wav> --out <dir>`: `kick` (drum-stem onsets
at 30 to 150 Hz), `snare` (150 Hz to 5 kHz) and `hat` (6 to 16 kHz), a snare or
hat onset within 45 ms of a kick dropped as the kick's click, and a hat onset within
45 ms of a snare dropped as the snare's noise in the top band. An onset is timed
where the band's envelope crosses a quarter of its rise. `hits`: the impact
score per 10 ms, the jump of the next 0.6 s over the previous 1.5 s of each
envelope as `max(mix, 0.9 drums, 0.7 bass)`, its peaks at 0.22 or more snapped
to the nearest drum onset within 0.65 s and merged within 2 s. `risers`: the
bass and other stems (else the mix less the drums) rising, small dips allowed,
by 6 dB or more over at least two beats (1 s without a beat map), landing on a
hit. `fills` (with `--beats <beats.json>`; empty without): the beat before each
hit, and the last half of any bar holding more drum onsets than the bars' usual
last half. `vocal_entries`: where the vocal stem rises over 40 dB under its peak
after at least 0.25 s under it. `env24`: the drums', vocals' and bass' RMS per
frame at 24 fps, scaled 0 to 1 (all zeros without a bass stem). The folder needs
`drums.wav` and `vocals.wav`; `bass.wav` and `other.wav` are used when there;
the report lists which (`used`, `absent`).

`film:window --vocals <vocals.wav> --words <words.json> --song-t0 <s> --duration <s> --out <dir> [--from N --to N] [--name <id>]`:
the clean vocal window for a sung clip (toolkit item 14). `--song-t0` is the
shot's start and `--duration` the clip's length, both in song time: the stem is
cut at `[song_t0, song_t0 + duration]`, so the file's first sample is song time
`song_t0` and the file is exactly `duration` long. That `song_t0` is the clip
file's `song_t0`: `film:edl` plays the take from `in = t0 - song_t0 + lag_s`,
and `film:sync --song-t0` takes the same value; the clip file's `window` is
the file's span, `{t0: song_t0, t1: song_t0 + duration}`, not the voice's
`t0`/`t1` the report gives. A shot cut on a beat in the
silence before the singer keeps its silence; the window is never moved to the
voice. The phrase's words are `--from` to `--to` (both or neither), or, without
them, the words that start inside `[song_t0 - 0.02, song_t0 + duration - 0.08)`.
Refused (exit 2) with the word named: a window that starts or ends inside a
word (`the window starts at 1.16 s inside word 0 "the" (1.00 to 1.31): start it in a word gap`),
a word of `--from`/`--to` outside the window, and a window no word starts in.
Words are merged into phrases across gaps of 0.35 s or less; each phrase is
kept from 0.05 s before its first word (never before the window's start or the
end of the word ahead) to its last word's end plus a release tail that follows
the stem's 10 ms energy until it falls 24 dB under the phrase's peak (at least
the 15 ms fade, at most 0.40 s, never past the next word's start less 0.05 s
nor the window's end); 15 ms raised-cosine ramps on every gate edge and silence
elsewhere, so a word of the window outside the phrase is silent. The kept part
is normalised to -16 dBFS RMS and limited to peaks at or under -1 dBFS (a 5 ms
lookahead limiter, then the level again, until both hold). It writes
`<name>.wav` (16-bit, 44.1 kHz, mono) and `<name>.mp3` (192 kbps; `<name>`
defaults to `window-<from>-<to>`) and `window-report.json` with `song_t0`,
`duration`, `from`, `to`, the voice's `t0` and `t1` in song time, `tail`, the
`phrases`, the `words`, `rms_dbfs` and `peak_dbfs`. A kept part quieter than
-60 dBFS RMS before normalising (a silent vocal stem, or a silent stretch of it)
is checked and failed, exit 3, with no audio written and the report's `ok`
false (`rms_dbfs` null for digital silence):
`window: the kept phrases are silent (-inf dBFS RMS, want at least -60 dBFS)`.
A `--duration` under 4 s or over 8 s is refused. `--allow-short` lifts the 4 s floor; it exists for the
kit's tests (the test song's phrases are short) and a production run never
passes it.

### The board: `film:audit`, `film:sheet`, `film:depth`, `film:edl`

The board is `shots.json` in claudia.gallery's format (wiki/formats, "The
board"): `{version: 1, duration, chapters, shots, plates}`. The kit adds three
fields: a shot's `genuine` (true for real product footage) and `footage` (the
recorded file it plays), and a chapter's `box` (a short text, at most 60
characters). All three commands that read a board check it first and refuse it
(exit 2, one line per problem, at most 20) when it does not fit: an unknown
field at the top, in a shot, a type entry, a device, a chapter or a plate; a
shot id that is not `s` and three digits, or is used twice; `t0` not before
`t1`; a value outside its list (`framing` ECU, CU, MCU, MS, MWS, WS, FS, EWS,
OTS; `motion_tier` still, plate3d, motion, sung; a type's `mode` subtitle,
coverline, masthead, stack, mass; a device's `kind` counter, label, terminal,
chart, strike, spec-sheet and `key` W, B, H, F, T; `treatment` push, drift,
parallax-left, parallax-right, rise, settle or null; `transition_in` cut or
dither); a plate key, clip id or chapter id that is not letters, digits, `.`,
`-` and `_` (it names a file: a chapter id names `<chapter>.mp4` and its
sidecars in `--out`, so `../master` is refused before any path is touched); a
chapter id used twice (`chapters[1].id "ch01" is used twice`). A missing framing, a TODO or an empty field is not a schema
problem: the audit's `todo` gate reports it.

`film:audit` runs every gate of the storyboard wiki's audit, and the kit's
four more, over the board and the analysis. Each gate's result (`pass`,
`fail`, `deferred` or `skipped`), the shots it names and its problems go in
`audit-report.json`, with the board's sha256 (an approval is tied to it), a
summary and the warnings. Any failing gate is exit 3, one line per gate:
`gate <name>: <problem>; <problem>`, shot ids JSON-quoted.

| Gate | Fails when |
|---|---|
| `tile` | a gap or an overlap between shots; the first shot not at 0, the last not at the song's end (`beats.json`'s duration); the board's `duration` not the song's |
| `chapters` | the chapters not tiling the song from 0 to its end (a gap or an overlap over 0.03 s, the first not at 0, the last not at the song's end, or no chapters); adjacent chapter edges, even within 0.03 s, that land on different frames of the 24 fps grid (a chapter renders from the first frame at or after its `t0` up to the first at or after its `t1`, the chapter engine's rule: `gate chapters: "ch01" ends at 6.455 s (frame 155) and "ch02" starts at 6.462 s (frame 156): frame 155 is in neither`, or `... in both` for a doubled frame), or a first chapter that does not start on frame 0; a shot not inside its chapter (the one it overlaps most) within 0.03 s. Each chapter renders its own frames and `film:encode` joins them, so a gap or an overlap would shift the picture against the mix |
| `cuts` | a cut more than 0.03 s from a beat, from a hit in `hits.json`, or from the `hit` its shot declares |
| `sections` | a shot's `section` that is not a section of the beat map |
| `words` | a word (`words.json`) that starts in a shot whose `lines` leave its line out, or whose `type` has no text for it (a `type` entry for the line with empty text types its display line, as the chapter engine fills it; with neither, it fails) |
| `graphics` | a lyric line (from `display.txt`, or listed by a shot) with no device naming it |
| `lead` | her seconds on screen (`lead_on_screen`) under `--lead-share` of the song (default 0.7) |
| `budget` | the sung and motion shots' seconds over `--motion-seconds`, or their clips over `--motion-clips`; `skipped` with neither flag |
| `windows` | a sung shot outside 4 to 8 s or starting inside a word (it must start in a word gap: in `words.json`'s `gaps`, or between words); a motion shot outside 4 to 12 s |
| `plates` | one plate on two shots that are not next to each other; two clips starting from one plate |
| `banned` | a `--taboo` word (whole words, any case) in any authored text: a shot's `set`, `action`, `camera`, `chrome`, `section`, `prompt`, `notes`, `type` text and device `params`; a chapter's `name`, `set` and `box`; a plate's `set` and `prompt`. Ids, keys and closed vocabularies (framing, tier, treatment, transition, type mode, device kind and key, accent, plate, clip, footage) are not scanned. One problem per word and field |
| `treatments` | a 2.5D (`plate3d`) shot without a treatment, or two 2.5D shots in a row with the same one |
| `todo` | `TODO` or `TBD` (any case, whole words) or `???` anywhere in the board, except that in `type` text (a lyric may sing "todo") only capital `TODO`, `TBD` and `???` count; a shot with no framing or tier; a sung or motion shot with no clip; a 2.5D shot with no plate |
| `genuine` | a `genuine` shot whose `footage` or `clip` is not a recorded shot of `--walk-report` (`shots[].file` with `status: recorded`) or an entry of `--recordings` (`recordings[].file`): footage by name or base name, a clip id by a file's stem; `deferred` with `--defer provenance` (the board step defers it, the build enforces it). A genuine shot naming no clip or footage fails even then |
| `hook` | a `--hooks` entry (pipe-separated) that no shot types as a `masthead` or `mass` card with its whole text (any case, punctuation dropped, spaces folded); a hook written in parts with ` / ` also passes as a `stack` card whose lines (newlines or ` / `) are its parts in order. A card's text is what the chapter engine draws: an entry with empty `text` and a `line` counts as that line's display line |
| `box` | two chapters in a row in the same `box` |

It warns, without failing, when her share is over 85 percent, when two shots in
a row come in with the same transition (other than `cut`), when a plate no shot
uses is listed, and when a sung shot's prompt may put a microphone, a hand or
hair in front of her mouth. At exit 0 it prints
`audit: 16 gates, all pass: 5 shots, 12.00 s, lead 83.6%, 2 clips (8.92 s)`
(with `(1 deferred)` or `(1 skipped)` when so) and one `warning: ...` line each.

`film:sheet` prints the board for review: `sheet.pdf` (A4 landscape, Chromium
through Playwright), the `sheet.html` it was printed from, and
`sheet-report.json` (`pages`, `cards`, `plates_found`, `prompt_cards`,
`face_flags`). The first page is the chapter map (id, name, time, sections,
set, accent, box); then twelve cards a page, in time order, each with the
plate (`<plates>/<plate>.png`, `.jpg` or `.jpeg`, embedded) or, where the plate
does not exist yet, a prompt card (the prompt's first 220 characters on the
shot's accent, else its chapter's); the id and time; the section and lines;
the framing and tier; the action in one line; the first device in one line;
and a `FACE?` badge when the shot's notes have the word "face" (or "faces"). Fonts are the kit's
own (Anton, Inter, IBM Plex Mono), embedded. The page count is read back from
the PDF and must be the cover plus one page per twelve cards.

`film:depth` prepares a plate for 2.5D (ruling R3): Depth Anything V2 Small
through transformers, on the CPU, resized to the plate and scaled to 16 bits,
near bright (`<name>.depth.png`); three soft mattes cut from the map's
terciles, far at or under the first, near at or over the second, mid between,
each blurred with one Gaussian whose ramp spans about 2 percent of the width,
so they add up to full white everywhere (`<name>.near.png`, `<name>.mid.png`,
`<name>.far.png`, 8-bit grey); and `<name>.boxes.json` with
`{faces: [], persons: [], detector: null, note}`, since the image carries no
face or person detector. `<name>` is the plate's file name less `.png`. A
plate must be a PNG of at least 256 px on each side. The same plate gives the
same bytes. The report holds the size, the model, the terciles, each layer's
share and the feather in pixels.

`film:edl` writes `edl.json`, keyed by shot id (wiki/formats, "The edit
list"). A sung or motion shot plays its clip's delivered take (`<clips>/<clip>.json`,
the take with `status: delivered`, a `file`, and the highest `n`) from the
shot's start: `{segs: [{t0, clip: "<clip>-t<n>", in}]}` with
`in = t0 - song_t0 + lag_s` (lag 0 when the take has no `sync`). A seg's
`clip` holds the take id (`W01-t2`), not the clip id wiki/formats gives: a
deliberate departure, so the chapter engine finds the take's file
(`<clips>/W01/take-2.mp4`) from the edit list alone, and a re-rolled take
changes the edit list. A take that starts late (a negative `in`: the take would
play from before its first frame, so the chapter engine would freeze frame 0
for the difference; sync measured a negative lag, or the clip's `song_t0` is
later than the shot's start) plays its plate until its first frame falls due,
then the take from `in: 0`: `{segs: [{t0: 0.976, plate}, {t0: 1.176, clip, in: 0}, ...]}`,
noted as a `late start` fallback. A late start of one frame or less (a lag one
sync hop off) snaps to the take's first frame with no note. A sung take
whose shot runs past its `sync.cut_at` (the take's first divergence) is cut
there to its first cover, which plays from there by its own `song_t0` and lag,
down the chain; this holds even when the shot ends inside a later
`sync.synced` span, so the out-of-sync stretch between two spans never plays. A `genuine` shot with `footage` is `{footage: "<file>"}` (the file the
walk or a terminal capture recorded; the chapter engine plays it like a clip;
a footage value that is not a plain file name, with a slash or `..`, fails with
exit 3: `edl: "s003" footage "../x.webm" is not a plain file name`);
a genuine shot without footage resolves as any other. A still or 2.5D shot is
`{plate}`, or `{design: true}` with `plate: null` (pure motion design). A hole
is filled from the shot's plate and noted in the report (`fallbacks`, and a
`fallback: ...` line on stdout): a clip or cover with no delivered take, a
delivered take with no `file`, or no clip file is `no take`; a sung take that
diverges with no cover is `no cover`; a take whose `cut_at` is at or before its
segment's start is `out of sync`; a take that starts more than a frame late is
`late start` (the plate plays the head); a clip with nothing usable makes the
whole shot `{plate}`. A sung or motion shot left with neither a take nor a
plate (none delivered, or a late start with no plate to fill the head) fails:
exit 3, one line each, the report written (`failures`: each shot and why) and
no `edl.json`. The summary
line counts the shots from takes, plates, footage and design. The report also gives, per sung shot, its sung
seconds (each word of `--words` padded 30 ms, merged under 0.12 s) and how many
of them the in-sync spans cover. A clip file that does not parse, or whose `id`
is not its file name, is refused.

The board tests use `tests/fixtures/board/`: a five-shot board over the test
song, the `beats.json`, `words.json` and `hits.json` the listening commands
make from it (one test makes them again and audits the board against them),
three clip files (one sung take cut to its cover, one straight), three plates
written by `tests/fixtures/board/make_plates.ts` (the fourth is left out for
the prompt card), a walk report and a recordings list.

### Moving shots: `film:request`, `film:ledger`, `film:sync`

The kit never spends money and never holds a key. A paid call goes through the
harness's `call_external` tool (spec 8.2): `film:request` shapes its input,
the skill asks it inside a tranche a person opened, and `film:ledger` records
what was asked and what came back.

`film:request --clip clips/<id>.json --provider openrouter|higgsfield --ledger ledger.jsonl --out <dir> --start-artifact <id> [--window-artifact <id>] [--resolution 480p|720p|1080p] [--rate-per-second <usd>]`
(or `--image <slot.json>` for an image slot, with `[--rate-per-image <usd>]`)
writes two files. `<id>.request.json` is exactly the `call_external` input of
spec 8.2, nothing more (the skill adds the id of the tranche it opened):

- `secret`: `OPENROUTER_API_KEY` or `HIGGSFIELD_API_KEY`, the name only.
- `url` and `method: POST`: the provider's endpoint for the model and the mode.
- `body`: the provider's own request shape. Every file it references is a
  `{{artifact:<id>}}` placeholder, which `call_external` replaces with a signed
  URL: the start image (`--start-artifact`, the plate or a cover's frame, saved
  as an artifact) and, for a sung clip, the clean vocal window
  (`--window-artifact`: the WAV for OpenRouter, the MP3 for Higgsfield; both
  providers want an HTTPS URL, never a `data:` URI). Duration, resolution and
  aspect ratio are body fields, never prompt words.
- `estimate`: dollars, rounded up to the cent: the clip's `body.duration`
  times the rate per second for the provider, the model and the resolution
  (the table below, or `--rate-per-second`), or one image at the image rate.
- `idempotency_key`: SHA-256 of the canonical JSON (keys sorted, no spaces) of
  `{attempt, body, model, provider}`. The attempt is the number of `asked` rows
  the ledger holds for the reference (the clip or slot id), on any provider,
  plus one. The same request shaped twice gets the same key, so a retry is
  reconciled, never paid twice; a re-roll, once its request is in the ledger,
  is the next attempt and gets a new key.
- `return: true` for a video clip: the submit is asynchronous and the job JSON
  comes back to the skill. `fetch_to: plates/cands/<id>/<attempt>.json` for an
  image slot: the call is synchronous and its response (the image) is streamed
  to the sandbox, never into the reply.

`<id>.request.meta.json` is the kit's side: `reference`, `kind`, `provider`,
`model`, `mode`, `attempt`, `idempotency_key`, `estimate`, the duration,
resolution and rate used, `prompt_words`, `request` (the request file's name),
and for a video clip the rest of the sequence:

1. Submit: `call_external` with the request; the job comes back.
2. Poll: `poll` is `{method: "GET", url, body: null}` on the provider's status
   URL, `{id}` or `{request_id}` being that field of the submit's job JSON; a
   `poll` call carries the original key and no estimate, and spends nothing.
3. Download: `download` is `{from, fetch_to: "clips/<id>/take-<attempt>.mp4"}`:
   `call_external` with `fetch_to` on the result URL the completed poll returns
   in the field `from` names (`unsigned_urls[0]` on OpenRouter, `video.url` on
   Higgsfield).

An image slot's meta has `poll` and `download` null.

The bodies, as documented on 2026-10-14; re-read the providers' pages at spend:

| Clip | OpenRouter (`bytedance/seedance-2.5`) | Higgsfield (`bytedance/seedance-2.5`) |
|---|---|---|
| sung window | `POST https://openrouter.ai/api/v1/videos`, reference mode: `input_references` with the plate as `image_url` (`@Image1`) and the window as `audio_url` (`@Audio1`), `generate_audio: true`. A first frame (`frame_images`) would make OpenRouter drop the audio. | `POST https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video`: `image_urls` [the plate], `audio_urls` [the window], `generate_audio: true` |
| motion | the same endpoint, `frame_images` [the plate, `frame_type: first_frame`], `generate_audio: false` | `POST https://api.higgsfield.ai/bytedance/seedance-2.5/image-to-video`: `image_url`, `generate_audio: false`, no aspect ratio (the first frame sets it) |
| poll | `GET https://openrouter.ai/api/v1/videos/{id}`, no body | `GET https://api.higgsfield.ai/requests/{request_id}/status`, no body |
| download | `fetch_to` on `unsigned_urls[0]` of the completed job (OpenRouter also serves it at `/api/v1/videos/{id}/content?index=0`) | `fetch_to` on `video.url` of the completed status |
| image slot | `POST https://openrouter.ai/api/v1/chat/completions` (`google/gemini-3-pro-image`): the prompt and the slot's `refs` as `image_url` parts, `modalities: ["image", "text"]`, `image_config.aspect_ratio`; synchronous, no poll | no known URL: refused |

The rates (`--rate-per-second` and `--rate-per-image` override them):

| Provider | Model | Rate |
|---|---|---|
| OpenRouter | `bytedance/seedance-2.5` | $0.103 a second at 480p, $0.231 at 720p (its listed price of $0.0000107 a video token, 1280x720 at 24 fps being 21,600 tokens a second; the wiki's "about $0.23 a second at 720p") |
| Higgsfield | `bytedance/seedance-2.5` | $0.70 a second at 720p (the films' list-price spend, $182 for 267 s and $347 for 492 s); 480p and 1080p need `--rate-per-second` (the wiki: ask for the price before each new configuration) |
| OpenRouter | `google/gemini-3-pro-image` | $0.14 an image |

A sung clip's prompt is the wiki's short sung form (toolkit item 16), built
from the clip: a head that names `@Image1` and `@Audio1`, says the soundtrack is
`@Audio1` copied unchanged, and quotes the clip's `words` in plain double
quotes; then the clip's `body.prompt` (one line of framing and light); then
"One continuous shot, no cuts, no head turns. Only she sings. No text, letters
or logos." A motion clip's or an image slot's prompt is its own, as written.
Over 90 words, or more than two timed beats (`0-1s`, `2 to 3 s`, `at 1.5 s`),
a sung prompt gets a warning (`warning: ...` on stdout and in the report);
over 110 words it is refused.

An image slot file is `{id, kind: "image", model, prompt, refs: [<artifact id>], aspect_ratio}`;
its file name is its id.

`film:request` refuses (exit 2, one line each, nothing written): a reference the
ledger marks `declined` on any provider; a sung window outside 4 to 8 s; braces
in a sung clip's words or prompt (Seedance reads `{...}` as lines to voice, and
re-sings them); a double quote in the words (the kit quotes the lyric); output settings in the prompt (`720p`, `4k`, `24 fps`, an
aspect ratio such as `16:9`, the words `resolution`, `duration` or `aspect ratio`,
`5 second clip`; a timeline's `0-1s:` is fine); over 110 words in a sung prompt;
a clip without `body.prompt`, `body.duration`, `start`, or, when sung, `window`
and `words`; a provider, or a model on a provider, without a known URL; a
resolution without a known rate. The summary line names the reference, kind,
provider, attempt, length, estimate and the key's first twelve digits:
`request: "W01" sung on openrouter, attempt 1, 5 s at 720p, estimate $1.16, key 3f9a0c1d2e4b`.

`film:ledger --ledger ledger.jsonl --out <dir>` with exactly one of:

- `--asked <request.json> [--meta <request.meta.json>]`: a request film:request
  shaped, as asked (the meta file defaults to the request's sibling
  `<id>.request.meta.json`; the key is recomputed from the request's body and
  the meta's provider, model and attempt, and a mismatch is refused);
- `--polled <key> [--figures <json>]`;
- `--delivered <key> --file <path> [--figures <json>]`;
- `--declined <key> [--reason <text>] [--figures <json>]`;
- `--failed <key> [--reason <text>] [--figures <json>]`;
- `--check <reference>`: prints the reference's state and writes it in the report.

It appends one row to the ledger, which must sit inside `--out`:
`{ts, kind, key, reference, attempt, provider, estimate, figures, file, reason}`.
It never rewrites a row and never writes through a link. A row after `asked`
names the key of an `asked` row and carries its reference, attempt, provider
and estimate. `--figures` is the provider's figures as returned, a JSON object
kept as given; the estimate is never quoted as spend. A `declined` row closes
the reference on every provider and is terminal: `film:request` refuses it from
then on, and so do `--asked`, `--polled`, `--delivered` and `--failed` for any
of its keys. A delivered key cannot be declined. `--check` prints
`ledger: "W01": 2 attempts, last delivered, declined on none, $2.32 asked`, and
the report's `state` is `{reference, attempts, last_kind, last_key, declined_on, delivered, estimate_total}`.

`film:sync --take <take.mp4|take.wav> --window <window.wav> --beats beats.json --song-t0 <s> --out <dir>`
measures a sung take against the clean vocal window it was given (toolkit item
15): Seedance copies the window into its own soundtrack, and the mouth follows
that soundtrack.

- Both are decoded to 16 kHz mono with ffmpeg (an MP4's first audio stream).
- Each becomes a log-mel spectrogram: 10 ms hop, 64 ms Hann frames, 80 bands
  from 50 to 7,600 Hz, floored 70 dB under its peak.
- The global lag is the shift within plus or minus 1.0 s where the normalised
  cross-correlation of the two mel envelopes (each band's mean removed over the
  overlap) peaks. That peak is the take's NCC: a `copy` over 0.2, else
  `diverged` (the model re-sang it).
- At that lag the NCC is measured over time in 0.5 s windows, a frame apart. A
  window counts when a quarter of its frames are active in either signal (frame
  RMS over 10 percent of the signal's 95th percentile). Silence in both bridges
  a span.
- `synced` holds the spans where the counted windows stay over 0.2, at least
  0.5 s long, ending where the next failing window starts. `diverge_at` is the
  first counted window at or under 0.2; a take that ends before the window
  does, while the window still holds voice, diverges at the take's end at the
  latest (`missing_tail_s` in the report). `cut_at` is the last eighth note
  (`beats.json`'s beats and the midpoints between them) at or before
  `diverge_at`.
- Times are song time: `--song-t0` plus the window time. `--song-t0` is the
  clip's `song_t0`: the song time of the window's first sample, which is the
  shot's start (`film:window --song-t0`), not the first word.
- It writes `<take>-sync.png` (our window's spectrogram, the take's on the same
  timeline, the NCC curve with the 0.2 line, the divergence in red) and
  `sync-report.json`. The report's `sync` is the take's entry for its clip
  file, `{lag_s, ncc, mode, synced, diverge_at, cut_at}`, and `curve` holds
  the NCC every 50 ms from `curve.t0`, the first measured window's start in
  song time (later than `--song-t0` when the take starts inside the window).
- A copy is exit 0:
  `sync: "take-2.mp4" copy, lag 0.31 s, NCC 0.41, synced 1.00 to 3.90, diverges at 4.02, cut at 3.99`.
  A take that does not copy is exit 3, with the report written:
  `sync: "take-2.mp4" does not copy the window (NCC 0.04, want over 0.2)`.

The tests use recorded bodies (`tests/fixtures/requests/<id>.<provider>.request.json`,
compared after the key is normalised, the key checked against its own
SHA-256), the board fixture's clip files with a motion clip and an image slot
beside them, and the window `film:window` cuts from the test song, with takes
made from it: the window itself, as a WAV and inside an MP4, 0.3 s late, 0.3 s
early, cut short at 3 s, with white noise after 2 s, and noise alone.

### Rendering: `film:chapter`, `film:gate`, `film:history`, `film:flash`, `film:mix`, `film:encode`, `film:reframe`, `film:captions`

The chapter engine is the kit's Remotion stack (spec D7, toolkit item 18), in
`src/remotion/film/`, beside the Teaser. `FilmChapter` (1920x1080, 24 fps) and
`FilmChapterVertical` (1080x1920) draw one chapter of the film; their props are
the chapter id and the paths `film:chapter` resolved (the board, the edit list,
`words.json`, `beats.json`, `hits.json`, `display.txt`, the plates, clips and
footage folders, and the brand). A browser cannot read those paths, so
`film:chapter` stages what the chapter needs in the render's public folder in
temp, and `calculateMetadata` reads it there, builds the plan once and takes
the chapter's length from its `t0` and `t1`.

One function draws: `plan.ts` builds a plain JSON plan from the inputs, and
`frameState(plan, frame)` says what a frame shows. The composition draws exactly
that, and `film:chapter` runs the same function in Node for the tokens sidecar
and the sound events, so the sidecar and the pixels cannot disagree. Every frame
is a pure function of the frame number and the props: no `Math.random`, no
clock, no state kept between frames (the history check proves it).

- **Time.** Frame F shows song time F / 24. A thing timed at t shows from the
  first frame at or after t (a cut, a word, a device's key); a chapter covers the
  frames from its `t0` to its `t1`, so chapters tile the song's frames.
- **Pictures, from the edit list.** `segs` play the take named by the take id
  (`W01-t2` plays `<clips>/W01/take-2.mp4`) at clip time `in + (t - t0)`,
  holding its last frame past its end; `plate` draws the plate still, or, for a
  `plate3d` shot, R3's three layers: the plate (far), the plate cut by its mid
  matte and by its near matte (`<plates>/<plate>.near.png`, `.mid.png`,
  `.far.png`, as `film:depth` writes them), moved by the shot's treatment
  (`push`, `drift`, `parallax-left`, `parallax-right`, `rise`, `settle`; 4
  percent at the near layer, 2 at mid, 1 at far, eased over the shot, a pure
  function of song time, every layer with a 6 percent overscan); `footage`
  plays `<footage>/<file>` from its first frame (a file outside the footage
  folder is refused); `design` is the brand's black.
- **Type, R4's five modes.** `subtitle` (the text face at 44 px, stepped down to
  36 to fit two lines, bottom left on a band, the sung word lit in the accent),
  `coverline` (one large line hung from the left axis), `masthead` (a
  full-frame card, white on black, the headline face at 12 to 16 percent of the
  frame's height), `stack` (a word to a row, the last the biggest and lowest)
  and `mass` (a wall of the word in the mono face in graphite, the line drawn
  over it). A `type[]` entry's `text` uses the display grammar (`TEXT|n` shows
  TEXT for n sung words, `|0` rides on the next token, `*x*` accent, `~x~`
  strike, `_x_` mono) and must consume exactly its line's words in
  `words.json`. A lyric block lays out its whole line from its first frame (the
  band sized from the full line, never moving or growing); a token not yet sung
  is in place but hidden and is not in the sidecar. Each token appears on its
  word's `t0`, never before it; a line carried across a cut shows its earlier
  words at the cut. A subtitle or coverline types its characters in from the
  word's `t0` at 24 to 40 characters a second, frame by frame, so the line is
  whole six frames before the cut; the rows of a terminal or a spec sheet, and
  every device step, land on the sixteenths. A lyric block runs to the next one
  (one lyric block a frame). A coverline must fit one line at 56 px (two in
  9:16) and a masthead two lines at its floor (130 px in 16:9, 97 px in 9:16),
  or the chapter is refused, so no drawn token is ever off the frame.
- **Devices, R4's six.** `counter` (counts to `params.to` on the sixteenths,
  at most sixteen steps), `label` (a tag that stamps in: white type on graphite,
  the accent only as the rule down its left edge), `terminal`
  (`params.lines`, one a sixteenth), `chart` (`params.series` as a line, or
  bars with `style: "bar"`, a point a sixteenth; a series given by name draws a
  plain rise under that name), `strike` (`params.text`, else its line's type
  text, struck over two sixteenths) and `spec-sheet` (`params.title` and
  `params.rows`, a row a sixteenth). A device enters on its key: `W` its line's
  first word, `B` the next beat, `H` the next hit of `hits.json` (else the next
  kick or snare), `F` the song frame `params.at`, `T` the song time
  `params.at`, and runs to the shot's end. The sixteenths are the beat map's
  beats, eighths and the eighths' midpoints. Anchors are a slot (`left`,
  `right`, `top`, `top-left`, `top-right`, `bottom`, `bottom-left`,
  `bottom-right`, `centre`; the slots share a left and a right column, where
  devices stack in board order) or `{x, y}` in percent. In 9:16 a shot's
  devices stack in the band above the picture, stepped down together to fit
  (never clipped); a set that would shrink under 60 percent is refused.
- **Colour.** Colours come from the brand's `palette.json` only: `black`,
  `warmWhite`, `graphite`, `silver`, and the accent (`accent`, else
  `productGreen`). A board's accent is used when the palette lists it. The
  accent goes to at most two elements a frame, in drawing order (type, then
  devices); later ones fall back to silver.
- **Chrome.** A corner HUD in the mono face, top right: `SESSION mm:ss`,
  `BAR n`, `BEAT n` from the beat map; hidden under a full-frame card and on a
  shot whose `chrome` is `"off"`.
- **Transitions.** `cut`, and `dither`: twelve frames in which the incoming
  picture shows through an 8x8 ordered-dither clip of 24 px cells over the
  outgoing shot still playing; each cell switches once.
- **Ramps.** A full-frame card (a design shot, a masthead or mass block) ramps
  its black over at least three frames before it and after it. Cuts are cuts:
  nothing else is ramped, and dense swaps still flash; the flash check is the
  guard. `--no-ramp` switches cards in one frame so a board can be made to fail
  the flash check; it is for the kit's tests only and is refused without
  `FILM_TEST=1` in the environment. The chapter report and the tokens sidecar
  record `ramp`, and `film:encode` refuses a chapter rendered with
  `ramp: false` unless `--allow-unramped`.

`film:chapter` renders `<chapter>.mp4` (or `<chapter>.9x16.mp4` with
`--vertical`) with `npx remotion render` (h264, BT.709, the kit's frame cache
cap and family-kill runner, a 15-minute limit); `--range t0:t1` (song seconds,
inside the chapter) renders part of it. It writes `<chapter>.tokens.json`, the
lyric gate's sidecar (R1: `{fps: 24, chapter, ramp, frames: [{t, tokens: [{word, text}]}]}`,
one entry per frame rendered, `t` its song time) and `<chapter>.audio.json`, the
sound events (`[{t, kind, gain, shot, what}]`: a device's entrance is a `tick`,
`stamp` or `type`, a dither a `whoosh`), and `chapter-report.json` with
ffprobe's duration, size, size in pixels, rate and colour tags:
`chapter: "ch01" 240 frames (10.000 s, 1920x1080, 24 fps, 2400395 bytes), 12 sung words drawn, 3 sound events`.
Everything the chapter needs is checked before any work (exit 2). On the test
chapter a ten-second render takes about 10 s on 4 CPUs.

`film:gate` (toolkit item 19) reads the sidecar: every sung word whose start
falls in the sidecar's span must be listed on the frame holding its start, or
one frame either side. It prints `gate: 12/12`; exit 3 adds one line per word,
`gate: word 6 "windows" at 4.730 s (frame 113) is not drawn`. The display text
must consume each line's words exactly (exit 2 otherwise).

`film:history` (toolkit item 20) renders frame B alone with
`npx remotion still`, then `FilmHistory` renders frame A and then frame B in one
page (one tab, in order), and compares the two B frames as raw RGB. Any channel
more than 40 levels apart fails (exit 3,
`history: frame 60 differs by 238 levels at 322,595 after frame 190 (...)`);
otherwise it prints `HISTORY-INDEPENDENT`. It keeps both PNGs in `--out`.
`--test-leak` (refused without `FILM_TEST=1`) draws a test-only probe that
remembers the frames a page has drawn, so the tests can show the check fails.

`film:flash` (toolkit item 21) decodes the video at 96x54 and 24 fps and asks
`film_py.flash`: linear relative luminance per pixel; a transition is a run of
the frame's mean one way by 0.1 or more, the darker end under 0.8, a quarter of
the pixels moving 0.1 the same way; a flash is a pair of opposing transitions
(pairs, not transitions); more than three in any one-second window fails (exit
3, one line per failing stretch). A single-frame pop (a frame 0.03 off both
neighbours the same way) is flagged, never failed: one
`warning: a single-frame pop at 0.500 s (frame 12): mean luminance 0.127 -> 0.165 -> 0.127`
line per pop, whatever the exit code. The report lists every transition, flash,
window and pop and the mean luminance per frame.

`film:mix` places each event's sound (`<sounds>/<kind>.wav`) at its time and
gain, ducks the events under the vocal stem with `sidechaincompress`, adds the
master, and brings the mix to the master's own integrated loudness, measured
with `ebur128`; the limiter runs only when the levelled mix would peak over
-0.2 dBFS (the report says which). It writes `mix.wav` (48 kHz, 24-bit,
stereo). A film with no sound events (every `--events` file an empty list, `[]`)
is legitimate: the mix is the master alone, levelled and measured the same way
(`mix: 0 events under the master, ...`). An event at or past the master's end is
refused before any work (exit 2). A mix more than 1 LU from the master after levelling is checked and failed
(exit 3, the report written); no test fixture forces that case. The four sounds are synthesised, never committed:
`python3 -I src/film/py/film_py/sounds.py --dest <dir>` writes `tick.wav`,
`stamp.wav`, `type.wav` and `whoosh.wav` (48 kHz 24-bit, a fixed seed); the
image build runs it beside `models.py`.

`film:encode` concatenates the chapters (ffmpeg's concat demuxer, in the order
given), muxes the mix (AAC 256k) and writes `master.mp4` (libx264 CRF 16,
preset slow, yuv420p, converted to and tagged BT.709 primaries, transfer and
matrix) and `review.mp4` (CRF 20, `-maxrate 8M -bufsize 16M`). Both are read
back with ffprobe: the duration within 0.5 s of the chapters' sum either way
(a tolerance for ffprobe's rounding of AAC priming and the last frame; nothing
caps the length, so a mix that runs on shows as an overrun), the three
tags, 24 fps, h264 and AAC, or exit 1 (the safety net). Refused before any
encode: a mix shorter or longer than the chapters by more than a frame (1/24 s,
plus 5 ms for the probe), so the master's sound cannot drift from its picture;
and, unless `--allow-unramped`, a chapter whose tokens sidecar
beside it (`<name>.tokens.json`) says `ramp: false`, or that has no sidecar at
all (fail closed).

`film:reframe` is `film:chapter --vertical` with `--aspect 9:16`: the same
timeline at 1080x1920, the picture across the frame's width on the brand's
black, the devices stacked above it, the type re-flowed beneath it at the
master's pixel sizes (stepped down to a floor to fit two lines), full-frame
cards full-frame. Its own sidecar, `<chapter>.9x16.tokens.json`, goes to
`film:gate` like the master's.

`film:captions` writes `captions.srt`, one cue per display line (the markers
and counts stripped), from the line's first word's start to its last word's
end, and with `--video` burns it in with ffmpeg's `subtitles` filter in Inter,
the brand's warm white outlined in its black from `palette.json`
(`captioned.mp4`). The cues are song time, so `--video` must be the full master
(or anything that starts at the song's first sample), never a chapter.

The tests build a project from the board fixture's analysis: a ten-second
chapter (a still plate, a sung shot on a fake take made with ffmpeg's
`testsrc2`, a line carried across a cut onto a still, SMPTE-bar footage, a
`push` 2.5D shot entering on a dither, a design shot with a masthead, a label
and a counter, the chrome), its edit list made by `film:edl`, and painted
plates and mattes.

### The test song

`python3 -I tests/fixtures/synth_song.py --out <dir>` builds the song every
film test listens to, with exact ground truth and no licensed audio: twelve
words in two sections, spoken by espeak-ng one word at a time (voice `en-us`,
speed 150, pitch 50) and trimmed to their first and last sound, each starting
on an eighth note; a kick on beats 1 and 3, a snare on 2 and 4 and a hat on
every off-beat, generated with numpy from a fixed seed; the tempo rising
linearly from 120 BPM at the first beat to 123 at the end. It writes `song.wav`
(16-bit 44.1 kHz stereo, 12.0 s, sample for sample the sum of its stems),
`vocals.wav`, `drums.wav`, `lyrics.txt`, `display.txt` and `truth.json` (every
word's start and end, the beats, downbeats, kicks, snares and hats, the
sections and the tempo law). Two builds are byte for byte the same.
`--hats-only 2,3` drops the kick and snare from those bars (counted from 0) and
keeps their hats, for the hits and beats tests; the truth then lists only the
kicks and snares played, and `hats_only_bars`.

The other fixtures: `tests/fixtures/board/` (the five-shot board and its
analysis, see [The board](#the-board-filmaudit-filmsheet-filmdepth-filmedl)),
`tests/fixtures/requests/` (the recorded request bodies) and
`tests/fixtures/chapter.ts` (the ten-second test chapter, built in temp from
the board fixture, painted plates, a `testsrc2` take and SMPTE-bar footage).
Nothing in them is a real person, a real tenant or licensed audio.

## Test image and CI

The tests run in one container. To rebuild the image the kit's tests are run
in (`studio-kit-test:local` here), do what CI does, in this order:

1. Start from `mcr.microsoft.com/playwright:v1.63.0-noble` (Node, Chromium's
   libraries, Ubuntu 24.04).
2. `apt-get install --no-install-recommends` ffmpeg, fonts-inter,
   fonts-noto-core, fonts-noto-color-emoji, fonts-noto-cjk, sox, espeak-ng,
   python3, python3-pip and python3-venv.
3. Make a venv at `/opt/film-venv` and put its `bin` first on `PATH`.
4. In it, install torch, torchaudio and torchvision at the pins of
   `src/film/py/requirements.txt` from `https://download.pytorch.org/whl/cpu`
   (so nothing pulls a CUDA build), then `pip install -r` that file.
5. Set `FILM_MODELS=/opt/models` and run
   `python3 -I src/film/py/film_py/models.py --dest /opt/models` (about
   1.5 GB, no token needed).
6. Run `python3 -I src/film/py/film_py/sounds.py --dest /opt/sounds` for
   `film:mix`'s sounds (the tests make their own; a production image needs
   them).
7. With the kit mounted at `/kit`: `npm ci`, `npx remotion browser ensure`,
   `npm test`.

Measured on a 4-CPU, 6 GB container: a clean build takes about 3 minutes on
a fast network (apt 34 s, torch 26 s, the rest of the pins 20 s, the models
27 s, export 79 s), and the image is 8.65 GB (the venv 1.6 GB, the models
1.5 GB). `npm test` takes 6 minutes 20 seconds (306 tests); the Teaser's full
master render is 4 of those minutes, and the film chapter tests about one.
The two heaviest renders (the Teaser's master and the film chapter file) take
a lock in the temp folder (`tests/fixtures/heavy.ts`) so they never run side
by side; side by side on 4 CPUs a Remotion frame could pass its 30 s limit.

`.github/workflows/ci.yml` is one job of those steps on the free
`ubuntu-latest` runner, with `timeout-minutes: 30`. The venv is cached on the
hash of `requirements.txt` (and the image), the models on the hash of
`requirements.txt` and `models.py`, so either is rebuilt only when its pins
move. Estimated from the measures above (not yet seen on GitHub):

| Step | Cold | Warm |
|---|---|---|
| pull the Playwright image | 1.5 min | 1.5 min |
| apt | 1 min | 1 min |
| venv (pip, or restore 1.6 GB) | 2 min | 0.75 min |
| models (download, or restore 1.5 GB) | 1 min | 0.75 min |
| sounds, `npm ci`, browser | 1 min | 1 min |
| `npm test` | 6.5 min | 6.5 min |
| saving the two caches | 1.5 min | none |
| in all | about 15 min | about 11 min |

That is on a 4-vCPU runner (public repositories). A private repository's free
runner has 2 vCPUs and 7 GB, which may double the suite to about 12 minutes
(about 20 cold): still inside the limit, but with less room. The two caches
take about 3 GB of the repository's 10 GB, and the job needs about 11 GB of
the runner's disk.

## Known limits in v0.2.0

Found in review and left for a later release, one line each:

- The aligner, the beat map, the hits and the sync measure are tested on a synthetic spoken song, never on real singing; the first live film is that test.
- The fixture test of the drum hits is weak (the truth is exact by construction, the audio check loose).
- The Python runner's time limit is tested by render's runner tests, not by a film test.
- The 64 KB lyric limit is checked in Node only; a Python library that prints on stdout turns a run into exit 1.
- Floating-point results may differ in the last digits between machines.
- No automated test proves that every command writes only in `--out` (checked by hand).
- torch.hub could try a download if `models.json` lies about a file (the offline switches guard it).
- `models.py` recognises htdemucs by its exact weight file name.
- The whisper fallback test passes 8 of 10 words against a bar of 7, and is sensitive to the thread count.
- Words corrected by hand are not kept when `film:words` runs again.
- `film:window --allow-short` is accepted in production, though it is meant for the tests only.
- The trailing gap after the last word is not exercised by the fixture.
- A real hat played within 45 ms of a snare is dropped as the snare's noise.
- The audit does not check a shot's declared hit against `hits.json`, and any hit in `hits.json` passes a cut.
- The audit does not warn about a clip no shot plays.
- The audit does not check a shot's word line against `display.txt` or a plate key against `plates[]`.
- The depth test depends on the model's output.
- A "no take" fallback is noted in the edl report only (the edit list format has no note field).
- `{footage}` in the edit list plays from the file's first frame; there is no in point.
- `film:sync` decides copy or diverged on the whole take's NCC, so a take at 0.157 that holds 99 percent of its sung seconds exits 3; read the synced spans too.
- OpenRouter's `unsigned_urls[0]` download field is as documented, not yet seen live; re-read at spend.
- A take that starts late (negative lag, missing head) is not counted as a divergence by `film:sync`; `film:edl` fills the head from the plate.
- `film:request` does not check the clip's `window` or `--duration` against `body.duration`.
- The request meta file repeats the key and the estimate of the request.
- The chapter plan is built twice, in Node and in the browser, from the same inputs.
- Burned-in captions are not measured for BT.709 tags, and the burn font's provenance is not checked by a test.
- The 9:16 device heights are estimates; a long label may spill.
- 2.5D has no inpainting: the near layer shows a thin duplicate edge.
- A board accent is used only when `palette.json` lists it; otherwise the palette's accent.
- `film:chapter` stages takes and plates in temp (hard links where it can), so long takes can double disk use during a render.
- `film:mix`'s loudness exit 3 and `film:history`'s exit 3 have no natural fixture (history fails only through the test probe).
- `film:chapter --no-ramp` is a production flag locked behind `FILM_TEST=1`; ramps guard single pops, not dense swaps.
- The test image's Dockerfile is not in the repository; `ci.yml` and [Test image and CI](#test-image-and-ci) are the recipe.

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

`film:status` (one line, naming the first problem):

- `film:status: --status <path> is required`
- `film:status: ...` with the argument parser's own words
- `unexpected argument "..." (field=value pairs follow --set)`
- `--set wants field=value, got "..."`,
  `version and updated_at are set by film:status, not --set`,
  `cannot set "...": not a field of status.json`, `X is set twice`,
  `awaiting must be JSON: null or {kind, id}`,
  `expects must be JSON: a list of {key, name}`
- `status file cannot be read as JSON`, `status file is not a JSON object`
- `--status is the report's path (status-report.json in --out): the report would overwrite it`
- `X is missing` for a schema field; `version is N, want 1`;
  `stage is "...", want one of brief, song, ...`;
  `step must be a non-empty string`; `awaiting must be null or {kind, id}`,
  `awaiting.kind is "...", want ask or files`,
  `awaiting.id must be a non-empty string`,
  `awaiting has an unknown field "..."`;
  `expects must be a list of {key, name}`, `expects[N] must be {key, name}`,
  `expects[N].key must be a non-empty string`,
  `expects[N].name must be a non-empty string`,
  `expects[N] has an unknown field "..."`;
  `sandbox_id must be a non-empty string`;
  `updated_at must be a UTC time written YYYY-MM-DDTHH:MM:SS(.sss)Z`;
  `unknown field "..."`
- `--out is not a folder`

`film:score`:

- `film:score: --lyrics <path> and --out <dir> are required`
- `film:score: ...` with the argument parser's own words
- `lyrics file cannot be read`, `lyrics file is over 64 KB`,
  `lyrics file holds no lyric line`
- `--out is not a folder`
- `the cmudict dictionary is not installed (pip install -r src/film/py/requirements.txt)`

The listening commands share these: `--X cannot be read` for a path flag that is
not a readable file, `--X cannot be read as audio` for one that is not audio,
`--out is not a folder`, the argument parser's own words after
`film:<name>: `, and `model K is not in "/opt/models" (run ...)` for a model
they need (`htdemucs` for stems; `mms_fa` and `whisper_tiny` for words).

`film:stems`: `film:stems: --in <path> and --out <dir> are required`.

`film:beats`:

- `film:beats: --drums <path> and --out <dir> are required`
- `--downbeat-phase wants 0, 1, 2 or 3`
- `--tempo-range wants low,high in BPM, between 40 and 300`
- `--words needs --lyrics`, `--words is not a words.json`

`film:words`:

- `film:words: --vocals <path>, --lyrics <path> and --out <dir> are required`
- `--min-conf wants a number from 0 to 1`
- `the lyric sheet has no words to align`
- one line per lyric line with no letters:
  `lyric line 1 "..." has no letters to align: write it out in words or take it off the sheet`
- `--display has N lines, the lyric sheet M`; one line per display line that
  does not consume its words:
  `display line 2 ("We count|3 windows.") shows 5 words, its lyric line has 4`
- `--expect is not a words.json or a truth.json`,
  `--expect has N words, the lyric sheet M`

`film:hits`:

- `film:hits: --stems <dir>, --mix <path> and --out <dir> are required`
- `--stems is not a folder`, `--stems has no drums.wav` (or `vocals.wav`)
- `--beats is not a beats.json`

`film:window`:

- `film:window: --vocals <path>, --words <path>, --out <dir>, --song-t0 <s> and --duration <s> are required`
- `--song-t0 is "soon", want seconds from 0`, `--duration is "0", want seconds above 0`
- `--duration is 9.00 s, want 4 to 8 s`
- `--from and --to go together`
- `--from and --to want word indices, --from no later than --to`
- `--to N is past the last word (M)`
- `--name wants letters, digits, - and _`
- `--words is not a words.json`
- `the window starts at 1.16 s inside word 0 "the" (1.00 to 1.31): start it in a word gap`,
  `the window ends at 5.04 s inside word 6 "windows" (4.73 to 5.35): end it in a word gap`
- one line per phrase word outside the window:
  `word 0 "the" (1.00 to 1.31) is outside the window (2.63 to 6.63 s)`
- `no word starts inside the window (10.60 to 15.60 s)`

The board commands share these: `--X cannot be read` for a path flag that is
not a readable file, `--board is not a JSON file`, one `--board: ...` line per
schema problem (as in [The board](#the-board-filmaudit-filmsheet-filmdepth-filmedl)),
`--out is not a folder` and the argument parser's own words after
`film:<name>: `.

`film:audit`:

- `film:audit: --board, --beats, --words, --hits, --display and --out are required`
- `--beats is not a beats.json`, `--words is not a words.json`,
  `--hits is not a hits.json`, `--walk-report is not a walk-report.json`,
  `--recordings is not a recordings.json`
- `--display has 1 lyric line, words.json has 4`
- `--lead-share is "1.5", want a share from 0 to 1`,
  `--motion-seconds is "0", want seconds above 0`,
  `--motion-clips is "2.5", want a whole number`,
  `--defer is "beats", want provenance`

`film:sheet`: `film:sheet: --board, --plates and --out are required`,
`--plates is not a folder`.

`film:depth`: `film:depth: --plate <png> and --out <dir> are required`,
`--plate is not a PNG`, `--plate cannot be read as an image`,
`--plate is 200x120 px, want at least 256 px on each side`,
and `model depth is not in "/opt/models" (run ...)`.

`film:edl`:

- `film:edl: --board, --clips, --words and --out are required`
- `--clips is not a folder`, `--words is not a words.json`
- `--clips: "W02.json" is not a clip file`, `--clips: "W02.json" holds clip "W01"`

`film:request`:

- `film:request: --clip <clip.json> or --image <slot.json>, --provider, --ledger and --out are required`,
  `film:request: give --clip or --image, not both`
- `--provider "fal" has no known URL (openrouter or higgsfield)`,
  `"P001" model "google/gemini-3-pro-image" has no known URL on higgsfield`
- `--resolution is "4k", want 480p, 720p or 1080p`, `--rate-per-second is "0", want dollars above 0`,
  `no rate for bytedance/seedance-2.5 on higgsfield at 1080p: give --rate-per-second`,
  `no rate for google/gemini-3-pro-image on openrouter: give --rate-per-image`
- `--start-artifact is required for a clip`, `"W01" is sung: --window-artifact is required`,
  `"M01" is a motion clip: it takes no --window-artifact`, `--image takes no --start-artifact or --window-artifact`,
  `--start-artifact wants an artifact id (letters, digits, . _ : -)`
- `--clip is not a clip file`, `--clip: "W09.json" holds clip "W01"`, `"W01" kind is "dance", want sung or motion`,
  `--image is not an image slot file`, `--image: "P002.json" holds image slot "P001"`,
  `--image: "slot.json" has no id that names a file` (or `--clip`)
- one line per problem in the clip: `"W01" has no body.prompt` (`start`, `window`, `words`, `body.duration`, `model`),
  `"W01" window is 3.50 s (0.98 to 4.48), want 4 to 8 s`,
  `"W01" body.resolution is "4k", want 480p, 720p or 1080p`,
  `"W01" words have braces: the lyric goes in plain quotes` (or `prompt has braces`),
  `"W01" words have a double quote: the kit quotes the lyric`,
  `"W01" prompt has output settings ("720p", "16:9"): they go in the request, never the prompt`,
  `"W01" sung prompt is 120 words, want 110 or fewer`,
  `"P001" refs want artifact ids (letters, digits, . _ : -)` (an image slot)
- `"W01" was declined on openrouter: no request for it on any provider`
- `--ledger line 3 is not a ledger row`

`film:ledger`:

- `film:ledger: --ledger, --out and one of --asked, --polled, --delivered, --declined, --failed or --check are required`,
  `film:ledger: give one of --asked, --polled, --delivered, --declined, --failed or --check`
- `--delivered needs --file <path>`, `--file goes with --delivered only`, `--file cannot be read`,
  `--figures and --reason go with the rows after asked`, `--figures is not a JSON object`
- `--ledger must be inside --out (the ledger is appended to)`, `--ledger line 3 is not a ledger row`
- `--asked is not a request file`, `--meta cannot be read`, `--meta is not a request meta file`,
  `--meta goes with --asked only`,
  `--asked: the idempotency_key is not the key of the body, provider, model and attempt 2`,
  `--asked: key "..." is already in the ledger`,
  `--asked: "W01" attempt 1 is stale, the ledger holds 1 asked: shape the request again`,
  `--asked: "M01" was declined on higgsfield: no request for it on any provider`
- `--polled: key "..." is not in the ledger` (and the other row kinds), `--delivered: key "..." is already delivered`,
  `--declined: key "..." is already delivered`
- `--polled: "M01" was declined on higgsfield: the reference is closed` (and `--delivered`, `--failed`)

`film:sync`:

- `film:sync: --take, --window, --beats, --song-t0 and --out are required`
- `--take has no audio stream`, `--window cannot be read as audio`, `--beats is not a beats.json`,
  `--song-t0 is "soon", want seconds from 0`
- `--take and --window must each hold at least 0.5 s of audio`

`film:chapter` and `film:reframe` (and `film:history`, with `--frames`):

- `film:chapter: --board, --edl, --words, --beats, --hits, --display, --plates, --clips, --chapter, --out are required (missing ...)`
- `--edl is not an edl.json`, `--words is not a words.json`, `--beats is not a beats.json`, `--hits is not a hits.json`,
  `--plates is not a folder` (`--clips`, `--footage`, `--brand`), `--brand is not a brand folder with palette.json`,
  `--brand: fonts/Anton-Regular.ttf is missing`, `--brand: palette.json has no accent or productGreen colour`
- `--chapter: the board has no chapter "ch09"`
- the board's schema problems, as in [The board](#the-board-filmaudit-filmsheet-filmdepth-filmedl), among them
  `--board: chapters[0].id is "../master", want a key of letters, digits, dot, dash or underscore` and
  `--board: chapters[1].id "ch01" is used twice`, before any path is built or removed
- `--range is "soon", want t0:t1 in song seconds (t0 before t1)`, `--range "9:12" is not inside chapter "ch01" (0 to 10 s)`
- `--no-ramp is for the kit's tests only (FILM_TEST=1)`
- `--edl: "s003" has no entry`, `--edl: "s002" names take "W01", which is not <clip>-t<n>`,
  `--edl: "s001" names plate "../board/shots", which is not a plate key` (every key is checked before a path is built)
- `--clips: "s002" plays take "W01-t2", which is not in the clips folder`,
  `--plates: "s001" plays plate "p-dawn", which is not in the plates folder`,
  `--plates: "s005" is plate3d and plate "p-roof" has no near, mid and far mattes`,
  `--footage: "s004" plays footage "shot-01.mp4" and no --footage folder was given`,
  `--footage: "s004" footage "../board/shots.json" is outside the footage folder`,
  `--footage: "s004" plays "shot-01.mp4", which is not in the footage folder`,
  `--plates: "p-dawn.png" cannot be read as an image`,
  `--edl: "s003" has an entry that is not segs, plate, footage or design`
- the fit checks below measure the text drawn: an entry with no text of its own is fitted on its display line
- `--board: "s005" is plate3d and needs a treatment (one of push, drift, parallax-left, parallax-right, rise, settle)`,
  `--board: "s002" type[1] shows 3 sung words, line 1 has 4 in words.json`,
  `--board: "s002" type[0] coverline "..." does not fit one line at 56 px (16:9)`,
  `--board: "s006" type[0] masthead "..." does not fit two lines at 97 px (9:16)`,
  `--board: "s002" devices need 1216 px above the 9:16 picture, the band has 518 (they would shrink under 60 percent)`
- `film:reframe`: `--aspect is "4:5", want 9:16`; `film:history`: `--frames is "60", want A,B (two frames of the chapter)`,
  `--frames "60,999": chapter "ch01" has frames 0 to 239`, `--frames "60,60": A and B must differ`,
  `film:history: --range is not used here; name the two frames with --frames A,B`,
  `--test-leak is for the kit's tests only (FILM_TEST=1)`

`film:gate`: `film:gate: --tokens, --words, --display and --out are required`,
`--tokens is not a tokens sidecar ({fps: 24, frames: [{t, tokens: [{word, text}]}]})`,
`--words is not a words.json`, `--display has 3 lyric lines, words.json has 4`,
`--display line 1 ("We count|2 the windows.") shows 5 sung words, words.json has 4`.

`film:flash`: `film:flash: --video and --out are required`, `--video cannot be read as a video`,
`--video has no frames`.

`film:mix`:

- `film:mix: --master, --events, --vocals, --sounds and --out are required`
- `--master cannot be read as audio` (`--vocals`), `--sounds is not a folder`,
  `--sounds has no tick.wav (make them with python3 -I src/film/py/film_py/sounds.py --dest <folder>)`
- `--events: "ch01.audio.json"[0] at 20.000 s is outside the master (12.000 s)`,
  `--events: "ch01.audio.json"[1] kind "boom" is not one of tick, stamp, type, whoosh`,
  `... has no time (t, in song seconds)`, `... gain 2.5 is not 0 to 2`, `--events: "x.json" is not a list of events`

`film:encode`: `film:encode: --chapters <mp4>..., --mix and --out are required`,
`--chapters: "ch02.mp4" cannot be read as a video`, `--chapters: "wide.mp4" measures 320x180, the first 640x360`,
`--chapters: "ch02.mp4" runs at 30 fps, want 24`, `--mix cannot be read as audio`,
`--mix runs 2.000 s, shorter than the chapters (3.500 s)`,
`--mix runs 3.600 s, longer than the chapters (3.500 s) by more than a frame`,
`--chapters: "fl.mp4" was rendered with --no-ramp (its sidecar fl.tokens.json says ramp: false); give --allow-unramped to encode it anyway`,
`--chapters: "ch09.mp4" has no tokens sidecar beside it (ch09.tokens.json) to show how it was rendered; give --allow-unramped to encode it anyway`.

`film:captions`: `film:captions: --words, --display and --out are required`,
`--words is not a words.json`, `--display has 1 lyric line, words.json has 4`,
`--display line 1 (...) shows 5 sung words, words.json has 4`, `--video cannot be read as a video`,
`--brand has no fonts folder`, `--brand has no palette.json with black and warmWhite`.

Exit `3`, with the report written: `film:words`, the check's line and the words
off, as in [Listening](#listening-filmstems-filmbeats-filmwords-filmhits-filmwindow),
with `words.json` written too; `film:audit`, one `gate <name>: ...` line per
failing gate; `film:edl`, one `edl: "s004" has neither a take nor a plate (clip "W09" has no delivered take)`
(or `edl: "s002" has neither a take nor a plate (take "W01-t2" starts 0.200 s late (...))`) line
per shot, and no `edl.json`; `film:window`, `window: the kept phrases are silent (...)`
and no audio; `film:beats`, `beats: the drum stem is silent (no onsets)` and no `beats.json`; `film:sync`, `sync: "take-2.mp4" does not copy the window (NCC 0.04, want over 0.2)`;
`film:gate`, `gate: 10/12` and a line per word not drawn; `film:history`, the differing pixel; `film:flash`,
`flash: 4 flashes in one second between 0.042 and 2.000 s, want at most 3`; `film:mix`,
`mix: -20.1 LUFS, the master -18.3 LUFS (-1.8 LU off, want within 1)`.

Exit `1`, on stderr: `walk: the session file could not be removed`,
`walk: unexpected failure`, `render: unexpected failure` (the report could not
be written) and `changelog: unexpected failure`. A render step that fails exits
`1` too, with the step's `error` in `render-report.json`. A film command prints
`film:<name>: unexpected failure`, or for its Python side
`film:<name>: python film_py.<module> failed`,
`... took longer than N minutes`, `... printed no result`, or
`film:<name>: "python3" could not be started` (the interpreter's name, from
`FILM_PYTHON` when set, JSON-quoted). `film:window` prints
`film:window: ffprobe could not be started` (or `ffmpeg`) when the tool is not
on the path, and `film:window: ffmpeg could not encode the MP3`; `film:sync`
prints the same tool lines. `film:ledger` prints
`film:ledger: the ledger could not be appended to` (a link at the ledger's
name, or a write that failed). `film:sheet`
prints `film:sheet: the browser could not be started`,
`film:sheet: the browser could not print the sheet`,
`film:sheet: the browser took longer than 2 minutes` or
`film:sheet: the sheet printed on N pages, not M`. The rendering commands print
`film:chapter: rendering FilmChapter failed` (Remotion's own tail on stderr
under `FILM_DEBUG=1`), `film:chapter: ch01.mp4 measures WxH, want 1920x1080`,
`film:chapter: ch01.mp4 cannot be read back`,
`film:history: FilmHistory rendered N frames, want 2`,
`film:history: the two renders of frame B differ in size`,
`film:encode: master.mp4 runs 5.000 s, the chapters 3.500 s` (an encode that
does not measure up; every problem of both files on one line, joined by `; `),
`film:mix: measuring the loudness of mix.wav failed`,
`film:mix: the loudness of song.wav could not be measured`,
`film:<name>: ffmpeg took longer than 5 minutes`, and
`film:<name>: npx could not be started`. `film:sheet` also prints
`film:sheet: playwright could not be loaded`.

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
- R4, film fonts. `brand/fonts/Anton-Regular.ttf` (the nabb wordmark's face)
  comes from the Google Fonts repository at a pinned commit, with its `OFL.txt`;
  `IBMPlexMono-Regular.ttf` and `IBMPlexMono-Medium.ttf` come from
  `fonts/complete/ttf/` of IBM's `@ibm/plex-mono@2.5.0` release, with its
  `LICENSE.txt`. Each family's licence is under its own heading in
  `brand/fonts/OFL.txt`.
  - Anton: https://raw.githubusercontent.com/google/fonts/cee74d7ca45d66d5c1878c828645c862f2788d2d/ofl/anton/Anton-Regular.ttf
  - sha256 of `Anton-Regular.ttf`: `a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab`
  - Anton's licence: https://raw.githubusercontent.com/google/fonts/cee74d7ca45d66d5c1878c828645c862f2788d2d/ofl/anton/OFL.txt
  - IBM Plex Mono: https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip
  - sha256 of the zip: `6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c`
  - sha256 of `IBMPlexMono-Regular.ttf`: `7c6fbddca4b700be918f5f6183d9bd4464fa427fe435f0b480d77fe2bb8c5a43`
  - sha256 of `IBMPlexMono-Medium.ttf`: `98fbd727aae340b236955879dabed4d991aac9e8e90b3b2a67ce4a59221cc97c`

## Licences

- The kit is MIT (see `LICENSE`).
- Inter, Anton and IBM Plex Mono are licensed under the SIL Open Font License
  1.1. The licences travel with the fonts in `brand/fonts/OFL.txt`, one heading
  per family.
- Remotion is not MIT. Its free licence covers individuals and for-profit
  companies of up to 3 employees; a larger company needs a Remotion company
  licence (https://www.remotion.dev/license). Whether nabb needs one is open and
  is decided before the claw pins a release.
