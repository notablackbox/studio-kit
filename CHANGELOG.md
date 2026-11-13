# Changelog

## v0.4.0, 2026-11-06

`film:words` without `--expect` no longer stops a take on the aligners'
confidence, and no longer passes one on it either. Every other command, the
expected-times check, and `words.json` are unchanged. A caller pinned to v0.3.x
that stops on exit 3 alone must read the new exit 4 before it pins v0.4.0.

### Changed

- `film:words` without `--expect`: fewer than 90 percent of the words at
  confidence 0.5 or more is exit 4, a warning for a person's review, in place of
  exit 3. It prints the warning, then a `review spot: ...` line for every
  flag, not just the ear check's five. The report's `ok` and `check.ok` stay
  false, as before.
- `words-report.json`: `check.verdict` is `pass`, `fail` or `review`. Every
  existing field keeps its name and meaning.

### Unchanged

- With `--expect`, under 90 percent of the words within 0.10 s of the
  expected times is still exit 3. The 0.5 confidence cutoff, the 0.90 share,
  `--min-conf` (the fallback only), the flags and the ear check are as they
  were.

## v0.3.1, 2026-11-03

### Fixed

- `film:stems`: one split at a time on a box. Three at once ran the 6 GB box out
  of memory and the kernel killed some of them. A later split now waits for the
  one running, and its line and `waited_seconds` in `stems-report.json` say how long.
- Every `film:*` command that runs Python: a process killed by a signal now says
  which, and says out of memory for SIGKILL, in place of `failed` with no reason.

## v0.3.0, 2026-10-21

Three changes to `film:request`, `film:ledger` and `film:status` (Film spec
v1.4, section 6 and D3). `walk`, `render`, `changelog`, `routes.json`, the
other `film:*` commands and the Remotion compositions are unchanged, so a claw
pinned to v0.2.0 keeps working from this tree, except that `film:status`, and
every ledger used with `film:request` or `film:ledger --asked`, now want
`project` in `status.json`.

### Changed

- `film:request`: the idempotency key is the SHA-256 of
  `{attempt, body, model, project, provider}`, so two productions of one brief
  never share a key. `project` is read from the `status.json` beside
  `--ledger`; `film:request` and `film:ledger --asked` (which recomputes the
  key) refuse a ledger with no `status.json` beside it, or one without a valid
  `project`.
- `film:status`: `project`, the production's id (lowercase letters, digits and
  dashes, the first not a dash, 64 at most), is the schema's second field. It
  is required, minted once by the orchestrator when it writes the file, and
  never set after: `--set project=...` is refused.

### New

- `film:request --song <song/tasks/T1.json>` and
  `--wav <song/takes/S01.json>` on the new provider `unifically` (a hosted
  wrapper for Suno): `--song` shapes the task that makes a song's two takes
  (estimate $0.06, `--rate-per-task` overrides it), `--wav` the export of one
  take as a WAV (estimate $0.01). Both write the usual request and meta files
  and name `UNIFICALLY_API_KEY`. The poll envelope (`data.status`, `data.cost`,
  `data.clips[]`, `data.wav_url`) is read from the provider's documentation
  and is confirmed by the first live call. A task's title, tags and lyrics
  are measured in characters (code points), so an emoji counts once, and
  `--rate-per-task` is refused with `--clip` and `--image`.

## v0.2.0, 2026-10-15

The film engine: the `film:*` commands that take a song from a scored lyric to
a delivered music video by anabology's method (the Film claw spec, section 6).
`walk`, `render`, `changelog`, `routes.json`, `Teaser` and `TeaserSocial` are
unchanged in behaviour, so a claw pinned to v0.1.0 keeps working from this tree.

### New

- Control: `film:status` (the production's `status.json`, schema version 1)
  and `film:score` (syllables, stresses, scansion and assonance of a lyric
  sheet, with lint).
- Listening: `film:stems` (demucs `htdemucs`, four stems), `film:beats` (a
  beat map with a tempo curve, downbeats and sections), `film:words` (every
  sung word timed by the `MMS_FA` aligner, faster-whisper `tiny` as fallback,
  with an ear check), `film:hits` (kicks, snares, hats, hits, risers, fills,
  vocal entries) and `film:window` (the clean vocal window of a sung clip,
  cut from the shot's start for the clip's duration).
- The board: `film:audit` (the storyboard wiki's gates and the kit's four
  more, the chapters' tiling among them), `film:sheet` (the board as a PDF), `film:depth` (Depth Anything V2
  Small and three soft mattes for 2.5D) and `film:edl` (the edit list from the
  delivered takes).
- Moving shots: `film:request` (shapes a `call_external` request with its
  estimate and idempotency key; spends nothing), `film:ledger` (an append-only
  record of what was asked and what came back) and `film:sync` (how far a sung
  take copies its window).
- Rendering: `FilmChapter`, `FilmChapterVertical` and `FilmHistory` in
  `src/remotion/film/`; `film:chapter`, `film:reframe` (9:16), `film:gate`
  (the lyric gate on the tokens sidecar), `film:history` (one frame rendered
  alone and after another), `film:flash`, `film:mix`, `film:encode` and
  `film:captions`.
- The Python side in `src/film/py/` with CPU-only pins
  (`requirements.txt`), `models.py` for the four models, `sounds.py` for
  `film:mix`'s four sounds.
- Fonts: Anton and IBM Plex Mono beside Inter, each with its OFL text.
- Test fixtures: a synthetic song with exact ground truth
  (`tests/fixtures/synth_song.py`), a five-shot board, recorded request
  bodies and a ten-second test chapter.
- CI: one job with ffmpeg, the fonts, sox, espeak-ng, a cached venv, cached
  models, the sounds, the browser and the whole suite.

### The contract

Every film command is `npm --prefix /opt/studio run film:<name> -- <flags>`.
Exit `0` done and `<name>-report.json` written; `2` refused before any work,
one line per problem on stdout, nothing written; `3` checked and failed, one
line per failure on stdout and the report written; `1` anything unexpected,
one short line on stderr. Paths resolve against `INIT_CWD`, else the current
folder. A command writes only in `--out`, the system temp folder and
`node_modules`. Values from the input are printed JSON-quoted. Nothing spends
money or holds a key. Models live in `$FILM_MODELS` (default `/opt/models`); a
command whose model is absent refuses. The README lists every flag, output and
printed line.

### Fixed

- The render tests' new-session grandchild check no longer flakes under load:
  its pid file is written under a temporary name and renamed into place, so a
  kill that lands between creating and writing the file can no longer leave an
  empty one behind (test-side only; `render.ts` unchanged).
- The Teaser's full render and the film chapter renders no longer run side by
  side in the suite (a lock in the temp folder, test-side only), where a
  Remotion frame could pass its 30 s limit on a 4-CPU container.

### Known limits

The README's "Known limits in v0.2.0" lists them, one line each. In short: the
aligner, the beat map and the sync measure are tested on a synthetic spoken
song, not on singing; some board cross-checks (declared hits, plate keys,
chapter tiling) are not made; 2.5D shows a thin edge without inpainting; the
mix's loudness failure has no fixture, and the history failure is shown only
through a test probe; the test image's Dockerfile is not in the repository.

## v0.1.0, 2026-10-14

The first release: three npm scripts for the nabb Studio.

- `walk`: records a short walk through the product with Playwright, one clip
  per shot of a shot list checked against `routes.json`; `--dry-run`,
  `--synthetic` and `--only`; every navigation held to the walk host; the
  session file read once and removed.
- `render`: cuts a 45 to 60 second teaser (`Teaser`, 1920x1080) and its 4:5
  reframe (`TeaserSocial`) with Remotion from a cut script, plus a poster
  still; every child process in its own session, killed with its whole family
  on a time limit or a failure.
- `changelog`: turns one dated changelog entry into an HTML card for the site,
  text only, everything escaped.
- Brand marks, palette and Inter from nabb-fe; CI on the Playwright image.
