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
which is the same image the sandbox builds from, with the same steps the CI runs:

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
npm --prefix /opt/studio run film:window -- --vocals <vocals.wav> --words <words.json> --from N --to N --out <dir> [--name <id>]
npm --prefix /opt/studio run film:audit -- --board <shots.json> --beats <beats.json> --words <words.json> --hits <hits.json> --display <display.txt> --out <dir> [--lead-share 0.7] [--motion-seconds N] [--motion-clips N] [--taboo word,word] [--hooks "A|B|C"] [--defer provenance] [--walk-report <walk-report.json>] [--recordings <recordings.json>]
npm --prefix /opt/studio run film:sheet -- --board <shots.json> --plates <dir> --out <dir>
npm --prefix /opt/studio run film:depth -- --plate <plate.png> --out <dir>
npm --prefix /opt/studio run film:edl -- --board <shots.json> --clips <dir> --words <words.json> --out <dir>
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
`letters` (a lyric line with no letters, or an all-caps token sung letter by
letter), `order` (a word starting over 0.05 s before the one ahead), `gap` (over
1 s between two words of a line), `verylow` (`conf` under 0.1), `length` (a word
over 1.2 s, or over three times its line's median), `lowconf` (`conf` under 0.3,
or a time from the fallback). With `--display`, each display line must consume
exactly its lyric line's words (`TEXT|n` shows TEXT over n words, n defaults to
1, `|0` rides on the next token), else it is refused before any work.

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

`film:window --vocals <vocals.wav> --words <words.json> --from N --to N --out <dir> [--name <id>]`:
the clean vocal window for a sung clip, one phrase by word indices, cut with
ffmpeg. It starts 0.05 s before word `--from` (never before the end of the word
ahead) and ends in the gap after word `--to`. Words are merged into phrases
across gaps of 0.35 s or less; each phrase is kept from 0.05 s before its first
word to its last word's end plus a release tail that follows the stem's 10 ms
energy until it falls 24 dB under the phrase's peak (at least the 15 ms fade, at
most 0.40 s, never past the next word's start less 0.05 s); 15 ms
raised-cosine ramps on every gate edge and silence elsewhere. The kept part is
normalised to -16 dBFS RMS and limited to peaks at or under -1 dBFS (a 5 ms
lookahead limiter, then the level again, until both hold). It writes
`<name>.wav` (16-bit, 44.1 kHz, mono) and `<name>.mp3` (192 kbps; `<name>`
defaults to `window-<from>-<to>`) and `window-report.json` with `t0`, `t1`,
`length`, `tail`, the `phrases`, the `words`, `rms_dbfs` and `peak_dbfs`. A
window under 4 s or over 8 s is refused with its length. `--allow-short` lifts
the 4 s floor; it exists for the kit's tests (the test song's phrases are
short) and a production run never passes it.

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
dither); a plate key or clip id that is not letters, digits, `.`, `-` and `_`
(it names a file). A missing framing, a TODO or an empty field is not a schema
problem: the audit's `todo` gate reports it.

`film:audit` runs every gate of the storyboard wiki's audit, and the kit's
three more, over the board and the analysis. Each gate's result (`pass`,
`fail`, `deferred` or `skipped`), the shots it names and its problems go in
`audit-report.json`, with the board's sha256 (an approval is tied to it), a
summary and the warnings. Any failing gate is exit 3, one line per gate:
`gate <name>: <problem>; <problem>`, shot ids JSON-quoted.

| Gate | Fails when |
|---|---|
| `tile` | a gap or an overlap between shots; the first shot not at 0, the last not at the song's end (`beats.json`'s duration); the board's `duration` not the song's |
| `cuts` | a cut more than 0.03 s from a beat, from a hit in `hits.json`, or from the `hit` its shot declares |
| `sections` | a shot's `section` that is not a section of the beat map |
| `words` | a word (`words.json`) that starts in a shot whose `lines` leave its line out, or whose `type` has no text for it |
| `graphics` | a lyric line (from `display.txt`, or listed by a shot) with no device naming it |
| `lead` | her seconds on screen (`lead_on_screen`) under `--lead-share` of the song (default 0.7) |
| `budget` | the sung and motion shots' seconds over `--motion-seconds`, or their clips over `--motion-clips`; `skipped` with neither flag |
| `windows` | a sung shot outside 4 to 8 s or starting inside a word (it must start in a word gap: in `words.json`'s `gaps`, or between words); a motion shot outside 4 to 12 s |
| `plates` | one plate on two shots that are not next to each other; two clips starting from one plate |
| `banned` | a `--taboo` word (whole words, any case) in any string of the board: every field of a shot (set, camera, chrome, section, type, devices...), a chapter or a plate; one problem per word and field |
| `treatments` | a 2.5D (`plate3d`) shot without a treatment, or two 2.5D shots in a row with the same one |
| `todo` | `TODO` or `TBD` (any case, whole words) or `???` anywhere in the board; a shot with no framing or tier; a sung or motion shot with no clip; a 2.5D shot with no plate |
| `genuine` | a `genuine` shot whose `footage` or `clip` is not a recorded shot of `--walk-report` (`shots[].file` with `status: recorded`) or an entry of `--recordings` (`recordings[].file`): footage by name or base name, a clip id by a file's stem; `deferred` with `--defer provenance` (the board step defers it, the build enforces it). A genuine shot naming no clip or footage fails even then |
| `hook` | a `--hooks` entry (pipe-separated) that no shot types as a `masthead` or `mass` card with its whole text (any case, punctuation dropped, spaces folded); a hook written in parts with ` / ` also passes as a `stack` card whose lines (newlines or ` / `) are its parts in order |
| `box` | two chapters in a row in the same `box` |

It warns, without failing, when her share is over 85 percent, when two shots in
a row come in with the same transition (other than `cut`), when a plate no shot
uses is listed, and when a sung shot's prompt may put a microphone, a hand or
hair in front of her mouth. At exit 0 it prints
`audit: 15 gates, all pass: 5 shots, 12.00 s, lead 83.6%, 2 clips (8.92 s)`
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
`in = t0 - song_t0 + lag_s` (lag 0 when the take has no `sync`). A sung take
whose shot runs past its `sync.synced` spans is cut at its `sync.cut_at` to its
first cover, which plays from there by its own `song_t0` and lag, down the
chain. A `genuine` shot with `footage` is `{footage: "<file>"}` (the file the
walk or a terminal capture recorded; the chapter engine plays it like a clip);
a genuine shot without footage resolves as any other. A still or 2.5D shot is
`{plate}`, or `{design: true}` with `plate: null` (pure motion design). A hole
is filled from the shot's plate and noted in the report (`fallbacks`, and a
`fallback: ...` line on stdout): a clip or cover with no delivered take, a
delivered take with no `file`, or no clip file is `no take`; a sung take that
diverges with no cover is `no cover`; a take whose `cut_at` is at or before its
segment's start is `out of sync`; a clip with nothing usable makes the whole
shot `{plate}`. A sung or motion shot left with neither a take nor a plate
fails: exit 3, one line each, the report written and no `edl.json`. The summary
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

- `film:window: --vocals <path>, --words <path>, --out <dir>, --from <word> and --to <word> are required`
- `--from and --to want word indices, --from no later than --to`
- `--to N is past the last word (M)`
- `--name wants letters, digits, - and _`
- `--words is not a words.json`
- `window is 2.31 s (6.91 to 9.22), want 4 to 8 s`

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
`--plate is not a PNG`, `--plate is 200x120 px, want at least 256 px on each side`,
and `model depth is not in "/opt/models" (run ...)`.

`film:edl`:

- `film:edl: --board, --clips, --words and --out are required`
- `--clips is not a folder`, `--words is not a words.json`
- `--clips: "W02.json" is not a clip file`, `--clips: "W02.json" holds clip "W01"`

Exit `3`, with the report written: `film:words`, the check's line and the words
off, as in [Listening](#listening-filmstems-filmbeats-filmwords-filmhits-filmwindow),
with `words.json` written too; `film:audit`, one `gate <name>: ...` line per
failing gate; `film:edl`, one `edl: "s004" has neither a take nor a plate (clip "W09" has no delivered take)` line
per shot, and no `edl.json`.

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
on the path, and `film:window: ffmpeg could not encode the MP3`. `film:sheet`
prints `film:sheet: the browser could not be started`,
`film:sheet: the browser could not print the sheet`,
`film:sheet: the browser took longer than 2 minutes` or
`film:sheet: the sheet printed on N pages, not M`.

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
