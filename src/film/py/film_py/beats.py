"""The beat map behind film:beats (claudia.gallery's toolkit wiki, item 6).

    python3 -I -m film_py.beats '<spec>'

The spec is the one argument, JSON (stdin is read only when there is none, which the kit's
runner never does): {"drums": path, "downbeat_phase": null | 0..3, "tempo_range": [low, high],
"lyrics": null | path, "words": null | path}. Prints beats.json's content and a few figures.

1. Onset strength: the spectral flux of the drum stem every 4 ms, on square-root magnitudes
   below 5 kHz, so the grid goes on the kick and the snare, never the hats (the song wiki:
   "put the grid on the kick").
2. Local tempo on 20 s windows every 5 s: every BPM in 0.05 steps inside the tempo range and
   every phase in 4 ms steps (a coarse pass, then the fine steps around the best three); a
   window's score is the mean onset strength on its beats. With five windows or more, the
   weakest 20 percent are dropped (the breakdowns) and the curve is smoothed over three.
3. From the strongest window's beat, beats are stepped forward and back along the tempo curve,
   each snapped to the nearest drum onset within 30 ms.
4. Downbeats by a kick vote: per block of 32 beats, the phase (which of every four beats is
   beat 1) with the most low-band (30 to 150 Hz) onset energy. A block whose two best phases
   are within 10 percent abstains (kicks on 1 and 3 tie); when every block abstains, the first
   kick of the song decides among the tied phases. `downbeat_phase` overrides (manual).
5. Sections: one per [tag] of the lyric sheet. With words.json each starts on the downbeat its
   first word belongs to (a word less than 0.8 s before a downbeat is its pickup): source
   lyrics-tag. Without words the bars are shared evenly in the tags' order, named by the tags but
   heuristic. A tag with no line of its own, or one that would start where the one before
   starts, is merged into its neighbour with a note, so no section is empty. Without a sheet,
   one section (heuristic).
"""

import json
import sys

import numpy as np

from film_py import done, quiet, refuse, spec
from film_py import audio, lyrics

HOP = 0.004  # seconds between onset-strength frames: the phase step
WINDOW = 20.0
STEP = 5.0
SNAP = 0.03
BPM_STEP = 0.05
FLUX_TOP_HZ = 5000


def flux(x: np.ndarray, rate: int):
    """Spectral flux every HOP seconds (frame rate returned), square-root magnitudes, normalised."""
    hop = HOP * rate
    size = 2048
    window = np.hanning(size)
    top = int(FLUX_TOP_HZ * size / rate)  # bins below 5 kHz: the grid goes on the kick and snare, not the hats
    frames = int(len(x) / hop) + 1
    padded = np.concatenate([np.zeros(size // 2), x, np.zeros(size)])
    starts = np.round(np.arange(frames) * hop).astype(int)
    out = np.zeros(frames)
    previous = None
    for chunk in range(0, frames, 4096):
        idx = starts[chunk:chunk + 4096]
        block = padded[idx[:, None] + np.arange(size)] * window
        mag = np.sqrt(np.abs(np.fft.rfft(block, axis=1)[:, :top]))
        if previous is None:
            previous = mag[:1]
        diff = np.diff(np.vstack([previous, mag]), axis=0)
        out[chunk:chunk + len(idx)] = np.maximum(diff, 0).sum(axis=1)
        previous = mag[-1:]
    out = out - np.convolve(out, np.ones(25) / 25, mode="same")  # less the local mean (100 ms)
    out = np.maximum(out, 0)
    if out.max() > 0:
        out /= out.max()
    # A little smoothing, so a beat a few ms off its onset still scores.
    kernel = np.exp(-0.5 * (np.arange(-4, 5) / 2.0) ** 2)
    return np.convolve(out, kernel / kernel.sum(), mode="same")


def fit_window(strength: np.ndarray, t0: float, t1: float, low: float, high: float):
    """The (score, bpm, phase) whose beats in [t0, t1) land on the most onset strength."""
    fps = 1 / HOP
    first, last = int(t0 * fps), min(len(strength), int(t1 * fps))

    def scores(bpms, phases_for):
        best = []
        for bpm in bpms:
            period = 60.0 / bpm
            phases = phases_for(bpm, period)
            if len(phases) == 0:
                continue
            k = np.arange(int((t1 - t0) / period) + 1)
            at = t0 + phases[:, None] + k[None, :] * period
            idx = np.round(at * fps).astype(int)
            valid = (idx >= first) & (idx < last)
            vals = np.where(valid, strength[np.clip(idx, 0, len(strength) - 1)], 0.0)
            mean = vals.sum(axis=1) / np.maximum(valid.sum(axis=1), 1)
            j = int(np.argmax(mean))
            best.append((float(mean[j]), float(bpm), float(phases[j])))
        return best

    coarse = scores(np.arange(low, high + 1e-9, 0.25), lambda bpm, period: np.arange(0, period, 0.008))
    coarse.sort(reverse=True)
    fine = []
    for _, bpm, phase in coarse[:3]:
        bpms = np.round(np.arange(bpm - 0.5, bpm + 0.5 + 1e-9, BPM_STEP) / BPM_STEP) * BPM_STEP
        bpms = bpms[(bpms >= low) & (bpms <= high)]
        fine += scores(bpms, lambda b, period, phase=phase: np.arange(phase - 0.016, phase + 0.016 + 1e-9, HOP) % period)
    return max(fine)


def tempo_curve(strength: np.ndarray, duration: float, low: float, high: float):
    """Window fits: [{t, bpm, phase, score, centre}], the weakest dropped, the BPMs smoothed."""
    # A window every 5 s while at least half of one (10 s, or half a short song) is left.
    starts = [0.0]
    while duration - (starts[-1] + STEP) >= min(WINDOW / 2, duration / 2):
        starts.append(starts[-1] + STEP)
    fits = []
    for s in starts:
        e = min(duration, s + WINDOW)
        score, bpm, phase = fit_window(strength, s, e, low, high)
        fits.append({"t": s, "bpm": bpm, "phase": s + phase, "score": score, "centre": (s + e) / 2})
    kept = fits
    if len(fits) >= 5:
        cut = np.quantile([f["score"] for f in fits], 0.2)
        kept = [f for f in fits if f["score"] > cut] or fits
    bpms = np.array([f["bpm"] for f in kept])
    if len(bpms) >= 3:
        smooth = bpms.copy()
        for i in range(len(bpms)):
            smooth[i] = np.median(bpms[max(0, i - 1):i + 2])
        bpms = smooth
    for f, b in zip(kept, bpms):
        f["bpm"] = float(round(b / BPM_STEP) * BPM_STEP)
    return fits, kept


def step_beats(kept, onset_times, duration):
    """Beats stepped along the tempo curve from the strongest window's phase, snapped to onsets."""
    centres = np.array([f["centre"] for f in kept])
    bpms = np.array([f["bpm"] for f in kept])

    def period(t):
        return 60.0 / float(np.interp(t, centres, bpms))

    def snap(t):
        j = audio.near(onset_times, t, SNAP)
        return float(onset_times[j]) if j is not None else t

    anchor_fit = max(kept, key=lambda f: f["score"])
    anchor = snap(anchor_fit["phase"])
    beats = [anchor]
    t = anchor
    while True:
        nxt = snap(t + period(t))
        if nxt >= duration or nxt <= t:
            break
        beats.append(nxt)
        t = nxt
    t = anchor
    back = []
    while True:
        prev = snap(t - period(t))
        if prev < 0 or prev >= t:
            break
        back.append(prev)
        t = prev
    return back[::-1] + beats


def kick_vote(beats, kick_times, kick_strengths):
    """(phase, votes): the downbeat phase by low-band onset energy per block of 32 beats."""
    energy = np.zeros(len(beats))
    for i, b in enumerate(beats):
        j = audio.near(kick_times, b, SNAP)
        if j is not None:
            energy[i] = kick_strengths[j]
    votes = [0, 0, 0, 0]
    for block in range(0, len(beats), 32):
        part = energy[block:block + 32]
        per = np.array([part[(np.arange(len(part)) + block) % 4 == p].sum() for p in range(4)])
        order = np.argsort(per)[::-1]
        if per[order[0]] <= 0 or per[order[1]] >= 0.9 * per[order[0]]:
            continue  # abstains
        votes[int(order[0])] += 1
    if max(votes) > 0 and votes.count(max(votes)) == 1:
        return int(np.argmax(votes)), votes
    total = np.array([energy[np.arange(len(beats)) % 4 == p].sum() for p in range(4)])
    tied = [p for p in range(4) if total.max() > 0 and total[p] >= 0.9 * total.max()]
    hit = np.flatnonzero(energy > 0)
    if len(hit) and int(hit[0]) % 4 in tied:
        return int(hit[0]) % 4, votes
    return int(np.argmax(total)), votes


def sections(sheet, words, downbeats, duration, drums, rate):
    """(sections, notes): the beat map's sections, with their energy (the drums' RMS against the
    loudest second), and a note for every tag merged into a neighbour.

    A tag with no lyric line of its own is merged into the next tag that has lines (the last
    ones into the one before). With words, each tag starts on the downbeat its first word belongs
    to (`lyrics-tag`); without them the bars are shared evenly in the tags' order, and the times
    are a guess (`heuristic`). A tag that would start where the one before starts, or earlier, is
    merged into it, so no section is ever empty.
    """
    bars = list(downbeats)
    notes = []

    def bar_of(t):
        return int(np.searchsorted(np.array(bars) - 1e-6, t, side="right")) - 1 if bars else 0

    if sheet is None or not sheet[1]:
        spans = [("song", 0.0)]
        source = "heuristic"
    else:
        lines, tags = sheet
        kept, waiting = [], []
        for k, tag in enumerate(tags):
            stop = tags[k + 1]["first_line"] if k + 1 < len(tags) else len(lines)
            if stop <= tag["first_line"]:
                waiting.append(tag)
                continue
            for empty in waiting:
                notes.append(f"[{empty['name']}] has no lyric line of its own: merged into {tag['name']}")
            waiting = []
            kept.append({"name": tag["name"], "first_line": tag["first_line"], "stop": stop})
        for empty in waiting:
            if kept:
                notes.append(f"[{empty['name']}] has no lyric line of its own: merged into {kept[-1]['name']}")
        if not kept:
            spans, source = [("song", 0.0)], "heuristic"
        elif words is not None:
            source = "lyrics-tag"
            spans = []
            for k, tag in enumerate(kept):
                if k == 0:
                    spans.append((tag["name"], 0.0))
                    continue
                first = next((w for w in words if tag["first_line"] <= int(w["line"]) < tag["stop"]), None)
                if first is None:
                    notes.append(f"[{tag['name']}] has no timed word: merged into {spans[-1][0]}")
                    continue
                t = float(first["t0"])
                after = [d for d in bars if d >= t]
                before = [d for d in bars if d <= t]
                if after and after[0] - t < 0.8:
                    start = after[0]  # the pickup rule
                elif before:
                    start = before[-1]
                else:
                    start = t
                if start <= spans[-1][1]:
                    notes.append(f"[{tag['name']}] starts on the same downbeat as {spans[-1][0]}: merged into {spans[-1][0]}")
                    continue
                spans.append((tag["name"], start))
        else:
            source = "heuristic"
            spans = []
            n = len(bars)
            for k, tag in enumerate(kept):
                start = 0.0 if k == 0 else (bars[(k * n) // len(kept)] if bars else duration * k / len(kept))
                if spans and start <= spans[-1][1]:
                    notes.append(f"[{tag['name']}] has no bar of its own: merged into {spans[-1][0]}")
                    continue
                spans.append((tag["name"], start))

    second = audio.frame_rms(drums, rate, 1.0, int(np.ceil(duration)))
    loudest = second.max() if len(second) and second.max() > 0 else 1.0
    result = []
    for k, (name, t0) in enumerate(spans):
        t1 = spans[k + 1][1] if k + 1 < len(spans) else duration
        a, b = int(round(t0 * rate)), int(round(t1 * rate))
        rms = float(np.sqrt(np.mean(drums[a:b] ** 2))) if b > a else 0.0
        result.append({
            "name": name,
            "t0": round(float(t0), 4),
            "t1": round(float(t1), 4),
            "energy": round(min(1.0, rms / loudest), 3),
            "bar0": max(0, bar_of(t0)) if t0 > 0 else 0,
            "bar1": len(bars) if k + 1 == len(spans) else max(0, bar_of(t1)),
            "source": source,
        })
    return result, notes


def read_words(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        words = data["words"]
        for w in words:
            float(w["t0"])
            int(w["line"])
        return words
    except (OSError, ValueError, KeyError, TypeError):
        refuse(["--words is not a words.json"])


def main(argv) -> int:
    job = spec(argv)
    info = audio.check(job["drums"], "--drums")
    sheet = None
    if job.get("lyrics"):
        try:
            with open(job["lyrics"], "rb") as handle:
                sheet = lyrics.parse(handle.read().decode("utf-8", errors="replace"))
        except OSError:
            refuse(["--lyrics cannot be read"])
    words = read_words(job["words"]) if job.get("words") else None
    low, high = job.get("tempo_range") or [70, 180]

    with quiet():
        rate = audio.RATE
        drums = audio.read(job["drums"], rate)
        duration = len(drums) / rate
        strength = flux(drums, rate)
        fits, kept = tempo_curve(strength, duration, float(low), float(high))
        onset_times, _ = audio.onsets(drums, rate)
        beats = step_beats(kept, onset_times, duration)
        kick_times, kick_strengths = audio.onsets(drums, rate, 30, 150)
        if job.get("downbeat_phase") is not None:
            phase, method, votes = int(job["downbeat_phase"]), "manual", None
        else:
            phase, votes = kick_vote(beats, kick_times, kick_strengths)
            method = "kick"
        downbeats = beats[phase::4]
        found, notes = sections(sheet, words, downbeats, duration, drums, rate)

    r = lambda t: round(float(t), 4)  # noqa: E731
    done({
        "beats_json": {
            "duration": r(duration),
            "beats": [r(b) for b in beats],
            "downbeats": [r(b) for b in downbeats],
            "tempo": [{"t": r(f["t"]), "bpm": round(f["bpm"], 2)} for f in kept],
            "downbeat_phase": phase,
            "downbeat_method": method,
            "sections": found,
        },
        "kick_votes": votes,
        "section_notes": notes,
        "windows": [{"t": r(f["t"]), "bpm": round(f["bpm"], 2), "score": round(f["score"], 4), "kept": any(f is k for k in kept)} for f in fits],
        "sample_rate": info.samplerate,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
