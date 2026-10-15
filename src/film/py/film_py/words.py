"""The timed words behind film:words (claudia.gallery's toolkit wiki, item 5; formats: words.json).

    python3 -I -m film_py.words '<spec>'      (or the spec on stdin)

The spec: {"vocals": path, "lyrics": path, "display": null | path, "expect": null | path,
"min_conf": 0.5}.

1. Forced alignment of the sheet's words, romanised to the MMS_FA bundle's dictionary (a to
   z and the apostrophe, digits spelled out), on the vocal stem at 16 kHz: torchaudio's
   wav2vec2 MMS_FA emissions in 30 s chunks with 2 s of context either side, then a Viterbi
   pass (functional.forced_align). A word's `conf` is the mean probability over its frames.
   Each word's edges are then trimmed to the vocal energy: its end to the last 5 ms frame at a
   tenth of its peak, its start to the first such frame from 0.1 s before (never into the word
   before), since the aligner lets a final consonant run on into the silence after it.
2. A word under `min_conf` falls back, as the wiki merges them: to faster-whisper tiny's word
   with the same text heard between its placed neighbours (src whisper: Whisper's end; its
   start, except that a word over 0.45 s starts at the aligner's start when that falls inside
   it, else at the first 10 ms frame over 0.3 of its peak); else, between two placed words of
   its own line, to an even share of the gap (src interp); else it keeps the aligner's time.
3. The check: with `expect` (a words.json or the test song's truth.json), the share of words
   whose start and end are both within 0.10 s of the expected ones; else the share with `conf`
   at `min_conf` or more. Under 90 percent fails (exit 3 on the Node side).
4. The ear check, most urgent first, at most five spots: letters (a line with no letters, or an
   all-caps token sung letter by letter), order, gap (over 1 s between two words of a line),
   verylow (conf under 0.1), length (over 1.2 s, or over three times its line's median),
   lowconf (conf under 0.3, or a time from the fallback).
"""

import json
import sys

import numpy as np

from film_py import done, model, models_dir, offline, quiet, refuse, spec, threads
from film_py import audio, lyrics

SR = 16000
CHUNK = 30.0
CONTEXT = 2.0
TOLERANCE = 0.10
SHARE = 0.9
LEVEL = 0.05  # -26 dB under the word's peak
BRIDGE = 0.08
REACH = 0.25
HOP = 0.005
URGENCY = ["letters", "order", "gap", "verylow", "length", "lowconf"]


def read_text(path, flag):
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        refuse([f"{flag} cannot be read"])


def read_expect(path, count):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        spans = []
        for w in data["words"]:
            if "t0" in w:
                spans.append((float(w["t0"]), float(w["t1"])))
            else:
                spans.append((float(w["start"]), float(w["end"])))
    except (OSError, ValueError, KeyError, TypeError):
        refuse(["--expect is not a words.json or a truth.json"])
    if len(spans) != count:
        refuse([f"--expect has {len(spans)} words, the lyric sheet {count}"])
    return spans


def check_display(text, lines):
    shown = lyrics.display_counts(text)
    if len(shown) != len(lines):
        refuse([f"--display has {len(shown)} lines, the lyric sheet {len(lines)}"])
    problems = []
    for n, ((line, count), lyric) in enumerate(zip(shown, lines), start=1):
        if count != len(lyric["words"]):
            problems.append(f"display line {n} ({json.dumps(line, ensure_ascii=False)}) shows {count} words, its lyric line has {len(lyric['words'])}")
    if problems:
        refuse(problems)


def emissions(model_fa, signal):
    """Log-probabilities per 20 ms frame for the whole signal, computed in chunks."""
    import torch  # noqa: PLC0415

    per_frame = 320  # wav2vec2's stride at 16 kHz
    total = int(np.ceil(len(signal) / per_frame))
    parts = []
    step = int(CHUNK * SR)
    ctx = int(CONTEXT * SR)
    for a in range(0, len(signal), step):
        b = min(len(signal), a + step)
        lo, hi = max(0, a - ctx), min(len(signal), b + ctx)
        piece = torch.from_numpy(signal[lo:hi].astype(np.float32))[None]
        with torch.inference_mode():
            em, _ = model_fa(piece)
        em = em[0]
        first = int(round((a - lo) / per_frame))
        count = int(round((b - a) / per_frame))
        parts.append(em[first:first + count])
    em = torch.cat(parts)[:total]
    return em


def align(signal, words):
    """(t0, t1, conf) per word from the MMS_FA aligner."""
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415

    bundle = torchaudio.pipelines.MMS_FA
    fa = bundle.get_model(with_star=False)
    fa.eval()
    dictionary = bundle.get_dict(star=None)
    em = emissions(fa, signal)
    tokens = [[dictionary[c] for c in w if c in dictionary] for w in words]
    flat = [t for word in tokens for t in word]
    frames = em.shape[0]
    if len(flat) == 0 or frames < len(flat) * 2:
        return [(0.0, 0.0, 0.0) for _ in words], frames
    alignment, scores = torchaudio.functional.forced_align(em[None], torch.tensor([flat], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(alignment[0], scores[0].exp())
    seconds = len(signal) / SR / frames
    result = []
    k = 0
    for word in tokens:
        mine = spans[k:k + len(word)]
        k += len(word)
        if not mine:
            result.append((0.0, 0.0, 0.0))
            continue
        weight = sum(s.end - s.start for s in mine)
        conf = sum(float(s.score) * (s.end - s.start) for s in mine) / max(weight, 1)
        result.append((mine[0].start * seconds, mine[-1].end * seconds, conf))
    return result, frames


def refine(spans, env, hop, floor):
    """Word edges moved to the vocal energy: [(t0, t1, ...)] -> the same with new t0, t1.

    From the word's loudest frame inside its span, walk out either way through frames at
    LEVEL of that peak (or the stem's noise floor, if higher), bridging quiet runs shorter
    than BRIDGE (a stop's closure inside a word). The walk never crosses the edges of the
    words either side, and moves an edge by at most REACH past where the span put it.
    """
    out = []
    for n, span in enumerate(spans):
        t0, t1 = span[0], span[1]
        before = out[n - 1][1] if n else 0.0
        after = spans[n + 1][0] if n + 1 < len(spans) else len(env) * hop
        # The peak is looked for inside the span, and never past the neighbours' edges.
        a = max(0, int(t0 / hop), int(np.ceil(before / hop)))
        b = min(len(env), max(int(t0 / hop) + 1, int(np.ceil(t1 / hop))), int(after / hop))
        if b <= a or env[a:b].max() <= 0:
            out.append(span)
            continue
        peak_at = a + int(np.argmax(env[a:b]))
        level = max(LEVEL * env[peak_at], floor)
        lo = max(int(np.ceil(before / hop)), int((t0 - REACH) / hop), 0)
        hi = min(int(after / hop), int((t1 + REACH) / hop), len(env) - 1)
        gap = int(BRIDGE / hop)
        first = last = peak_at
        k = peak_at
        while k < hi:
            ahead = np.flatnonzero(env[k + 1:min(hi, k + gap) + 1] >= level)
            if not len(ahead):
                break
            k = k + 1 + int(ahead[0])
            last = k
        k = peak_at
        while k > lo:
            behind = np.flatnonzero(env[max(lo, k - gap):k] >= level)
            if not len(behind):
                break
            k = max(lo, k - gap) + int(behind[-1])
            first = k
        new0, new1 = first * hop, (last + 1) * hop
        out.append((new0, max(new1, new0 + hop), *span[2:]))
    return out


def whisper_words(signal):
    from faster_whisper import WhisperModel  # noqa: PLC0415

    folder = model("whisper_tiny")
    heard = []
    wm = WhisperModel(str(folder), device="cpu", compute_type="int8", cpu_threads=threads())
    segments, _ = wm.transcribe(signal.astype(np.float32), language="en", word_timestamps=True, beam_size=5,
                                vad_filter=False, condition_on_previous_text=False)
    for segment in segments:
        for w in segment.words or []:
            text = lyrics.romanised(w.word).replace(" ", "")
            if text:
                heard.append({"w": text, "t0": float(w.start), "t1": float(w.end), "p": float(w.probability)})
    return heard


def fall_back(words, placed, min_conf, signal_env, hop, signal):
    """Words under min_conf, from Whisper or interpolated; returns (t0, t1, conf, src) per word."""
    result = [(t0, t1, conf, "w2v") for t0, t1, conf in placed]
    low = [i for i, (_, _, c, _) in enumerate(result) if c < min_conf]
    if not low:
        return result, False
    heard = whisper_words(signal)
    used = set()
    good = lambda i: result[i][3] != "w2v" or result[i][2] >= min_conf  # noqa: E731
    for i in low:
        before = next((result[j] for j in range(i - 1, -1, -1) if good(j)), None)
        after = next((result[j] for j in range(i + 1, len(result)) if good(j)), None)
        # Heard between its placed neighbours: the heard word's middle at most 0.3 s outside them.
        lo = before[1] - 0.3 if before else -1e9
        hi = after[0] + 0.3 if after else 1e9
        options = [k for k, h in enumerate(heard)
                   if k not in used and h["w"] == words[i]["w"] and lo <= (h["t0"] + h["t1"]) / 2 <= hi]
        if not options:
            continue
        k = min(options, key=lambda k: abs(heard[k]["t0"] - placed[i][0]))
        h = heard[k]
        t0 = max(h["t0"], before[1] if before else 0.0)
        t1 = min(h["t1"], after[0] if after else h["t1"])
        if t1 <= t0:
            continue
        used.add(k)
        if t1 - t0 > 0.45:
            if t0 < placed[i][0] < t1:
                t0 = placed[i][0]
            else:
                a, b = int(t0 / hop), int(np.ceil(t1 / hop))
                seg = signal_env[a:b]
                if len(seg) and seg.max() > 0:
                    t0 = (a + int(np.argmax(seg >= 0.3 * seg.max()))) * hop
        result[i] = (t0, max(t1, t0 + hop), h["p"], "whisper")
    # An even share of the gap for a run of unplaced words between two placed words of their line.
    i = 0
    while i < len(result):
        if good(i):
            i += 1
            continue
        j = i
        while j < len(result) and not good(j):
            j += 1
        line = words[i]["line"]
        if i > 0 and j < len(result) and words[i - 1]["line"] == line and words[j]["line"] == line and all(words[k]["line"] == line for k in range(i, j)):
            start, end = result[i - 1][1], result[j][0]
            if end > start:
                share = (end - start) / (j - i)
                for k in range(i, j):
                    result[k] = (start + (k - i) * share, start + (k - i + 1) * share, 0.0, "interp")
        i = j
    return result, True


def flags_for(sheet_lines, words, timed):
    found = []
    for n, line in enumerate(sheet_lines):
        if not line["words"]:
            found.append({"flag": "letters", "line": n, "t0": None, "message": f"line {n} has no letters"})
    for i, w in enumerate(words):
        if w["acronym"]:
            found.append({"flag": "letters", "i": i, "t0": timed[i]["t0"], "message": f"word {i} {json.dumps(w['token'])} at {timed[i]['t0']:.2f} s is sung letter by letter"})
    for i, t in enumerate(timed):
        tag = f"word {i} {json.dumps(t['w'])} at {t['t0']:.2f} s"
        if i and t["t0"] < timed[i - 1]["t0"] - 0.05:
            found.append({"flag": "order", "i": i, "t0": t["t0"], "message": f"{tag} starts before the word ahead of it"})
        if i and timed[i - 1]["line"] == t["line"] and t["t0"] - timed[i - 1]["t1"] > 1.0:
            found.append({"flag": "gap", "i": i, "t0": t["t0"], "message": f"{tag}: {t['t0'] - timed[i - 1]['t1']:.1f} s gap before it in its line"})
        if t["conf"] < 0.1 and t["src"] != "interp":
            found.append({"flag": "verylow", "i": i, "t0": t["t0"], "message": f"{tag}: confidence {t['conf']:.2f}"})
        mates = [x["t1"] - x["t0"] for x in timed if x["line"] == t["line"] and x is not t]
        length = t["t1"] - t["t0"]
        if length > 1.2 or (mates and length > 3 * float(np.median(mates))):
            found.append({"flag": "length", "i": i, "t0": t["t0"], "message": f"{tag}: {length:.2f} s long"})
        elif t["conf"] < 0.3 or t["src"] in ("whisper", "interp"):
            if t["conf"] >= 0.1 or t["src"] == "interp":
                found.append({"flag": "lowconf", "i": i, "t0": t["t0"], "message": f"{tag}: {t['src']}, confidence {t['conf']:.2f}"})
    found.sort(key=lambda f: (URGENCY.index(f["flag"]), f["t0"] if f["t0"] is not None else -1))
    return found


def main(argv) -> int:
    job = spec(argv)
    sheet_lines, _ = lyrics.parse(read_text(job["lyrics"], "--lyrics"))
    words = []
    for n, line in enumerate(sheet_lines):
        for w in line["words"]:
            words.append({**w, "line": n})
    if not words:
        refuse(["the lyric sheet has no words to align"])
    if job.get("display"):
        check_display(read_text(job["display"], "--display"), sheet_lines)
    expect = read_expect(job["expect"], len(words)) if job.get("expect") else None
    min_conf = float(job.get("min_conf", 0.5))
    audio.check(job["vocals"], "--vocals")
    root = models_dir()
    model("mms_fa")
    model("whisper_tiny")

    with quiet():
        offline(root)
        signal = audio.read(job["vocals"], SR)
        duration = len(signal) / SR
        placed, _ = align(signal, [w["w"] for w in words])
        env = audio.envelope(signal, SR, HOP, 0.01)
        # The stem's noise floor: twice its quietest tenth, so bleed never counts as a word.
        floor = 2 * float(np.quantile(env, 0.1)) if len(env) else 0.0
        placed = refine(placed, env, HOP, floor)
        merged, used_whisper = fall_back(words, placed, min_conf, audio.envelope(signal, SR, 0.01, 0.02), 0.01, signal)
        if used_whisper:
            # Whisper's own edges are coarse: refined the same way, its neighbours as they stand.
            again = refine(merged, env, HOP, floor)
            merged = [new if old[3] == "whisper" else old for old, new in zip(merged, again)]

    r = lambda t: round(float(t), 3)  # noqa: E731
    timed = [
        {"i": i, "w": w["w"], "line": w["line"], "t0": r(t0), "t1": r(t1), "conf": round(float(c), 3), "src": src}
        for i, (w, (t0, t1, c, src)) in enumerate(zip(words, merged))
    ]
    out_lines = []
    for n, line in enumerate(sheet_lines):
        own = [t for t in timed if t["line"] == n]
        if own:
            out_lines.append({"line": n, "text": line["text"], "t0": own[0]["t0"], "t1": own[-1]["t1"]})
    gaps = []
    if timed[0]["t0"] >= 2.0:
        gaps.append({"t0": 0.0, "t1": timed[0]["t0"], "after_word": None})
    for a, b in zip(timed, timed[1:]):
        if b["t0"] - a["t1"] >= 2.0:
            gaps.append({"t0": a["t1"], "t1": b["t0"], "after_word": a["i"]})
    if duration - timed[-1]["t1"] >= 2.0:
        gaps.append({"t0": timed[-1]["t1"], "t1": r(duration), "after_word": timed[-1]["i"]})

    failures = []
    if expect is not None:
        within = 0
        off = []
        for t, (e0, e1) in zip(timed, expect):
            if abs(t["t0"] - e0) <= TOLERANCE and abs(t["t1"] - e1) <= TOLERANCE:
                within += 1
            else:
                off.append(f"word {t['i']} {json.dumps(t['w'])}: starts {t['t0'] - e0:+.2f} s, ends {t['t1'] - e1:+.2f} s off")
        check = {"by": "expect", "within": within, "of": len(timed), "tolerance": TOLERANCE}
        ok = within >= SHARE * len(timed)
        if not ok:
            failures = [f"words: {within} of {len(timed)} within 0.10 s of the expected times, want at least 90 percent"] + off[:20]
    else:
        within = sum(1 for t in timed if t["conf"] >= min_conf)
        check = {"by": "conf", "within": within, "of": len(timed), "min_conf": min_conf}
        ok = within >= SHARE * len(timed)
        if not ok:
            failures = [f"words: {within} of {len(timed)} with confidence {min_conf:g} or more, want at least 90 percent"]
    check["share"] = round(within / len(timed), 3)
    check["ok"] = ok
    flags = flags_for(sheet_lines, words, timed)
    done({
        "words_json": {"words": timed, "lines": out_lines, "gaps": gaps},
        "check": check,
        "failures": failures,
        "flags": flags,
        "ear_check": flags[:5],
        "sources": {s: sum(1 for t in timed if t["src"] == s) for s in ("w2v", "whisper", "interp")},
        "whisper_ran": used_whisper,
        "lines": len(out_lines),
        "duration": r(duration),
        "models": {"aligner": "torchaudio MMS_FA", "fallback": "faster-whisper tiny"},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
