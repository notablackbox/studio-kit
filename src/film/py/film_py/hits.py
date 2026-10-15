"""The hit list behind film:hits (claudia.gallery's toolkit wiki, item 7; formats: hits.json).

    python3 -I -m film_py.hits '<spec>'

The spec is the one argument, JSON (stdin is read only when there is none, which the kit's
runner never does): {"stems": folder, "mix": path, "beats": null | path}. The folder holds drums.wav
and vocals.wav, and bass.wav and other.wav when film:stems wrote them.

- kick: onsets of the drum stem at 30 to 150 Hz; snare: at 150 Hz to 5 kHz; hat: at 6 to
  16 kHz. A snare or hat onset within 45 ms of a kick is the kick's click, and dropped; a hat
  onset within 45 ms of a snare is the snare's noise in the top band, and dropped too.
- hits: the impact score per 10 ms frame, the jump of the next 0.6 s over the previous 1.5 s
  of each envelope (0 to 1), as max(mix, 0.9 x drums, 0.7 x bass); its peaks at 0.22 or more,
  snapped to the nearest drum onset within 0.65 s, merged within 2 s (the stronger kept).
- risers: the other and bass stems (else the mix less the drums) rising, with small dips
  allowed, for at least two beats (1 s without a beat map) and by 6 dB or more, landing on a hit.
- fills (with a beat map): the beat before each hit, and the last half of any bar that holds
  more drum onsets than the bars' usual last half and breaks its pattern.
- vocal_entries: where the vocal stem rises above 40 dB under its peak after at least 0.25 s
  under it (or from the start), timed to the first sample over that level.
- env24: the RMS of drums, vocals and bass per frame at 24 fps, scaled 0 to 1 (bass all zeros
  without a bass stem).
"""

import json
import os
import sys
from collections import Counter

import numpy as np

from film_py import done, quiet, refuse, spec
from film_py import audio

KICK_CLICK = 0.045
SNAP = 0.65
MERGE = 2.0
THRESHOLD = 0.22
SILENCE_DB = -40.0
SILENCE_MIN = 0.25
FRAME = 0.01


def bands(drums, rate):
    kick, kick_s = audio.onsets(drums, rate, 30, 150)
    snare, _ = audio.onsets(drums, rate, 150, 5000)
    hat, _ = audio.onsets(drums, rate, 6000, 16000)

    def apart(times, louder):
        return np.array([t for t in times if audio.near(louder, t, KICK_CLICK) is None])

    snare = apart(snare, kick)
    return kick, snare, apart(apart(hat, kick), snare)


def scaled_envelope(x, rate):
    env = audio.envelope(x, rate, FRAME, 0.05)
    top = env.max()
    return env / top if top > 0 else env


def jump(env):
    """Mean of the next 0.6 s less the mean of the previous 1.5 s, per frame."""
    ahead, behind = int(round(0.6 / FRAME)), int(round(1.5 / FRAME))
    c = np.concatenate([[0.0], np.cumsum(env)])
    n = len(env)
    i = np.arange(n)
    nxt = (c[np.minimum(n, i + ahead)] - c[i]) / ahead
    prv = (c[i] - c[np.maximum(0, i - behind)]) / behind
    return nxt - prv


def impacts(mix, drums, bass, rate, onset_times):
    n = len(audio.envelope(mix, rate, FRAME, 0.05))
    parts = [jump(scaled_envelope(mix, rate))[:n], 0.9 * jump(scaled_envelope(drums, rate))[:n]]
    if bass is not None:
        parts.append(0.7 * jump(scaled_envelope(bass, rate))[:n])
    score = np.max(np.vstack([np.pad(p, (0, n - len(p))) for p in parts]), axis=0)
    radius = int(round(0.3 / FRAME))
    padded = np.concatenate([np.full(radius, -1.0), score, np.full(radius, -1.0)])
    local = np.lib.stride_tricks.sliding_window_view(padded, 2 * radius + 1).max(axis=1)
    found = []
    for i in np.flatnonzero((score >= THRESHOLD) & (score >= local)):
        t = i * FRAME
        j = audio.near(onset_times, t, SNAP)
        found.append((float(score[i]), float(onset_times[j]) if j is not None else t))
    kept = []
    for s, t in sorted(found, reverse=True):
        if all(abs(t - k[1]) >= MERGE for k in kept):
            kept.append((s, t))
    return sorted(((t, min(1.0, s)) for s, t in kept))


def risers(signal, rate, hits, min_len):
    env = audio.envelope(signal, rate, FRAME, 0.05)
    env = np.convolve(env, np.ones(20) / 20, mode="same")  # 200 ms
    top = env.max() if env.max() > 0 else 1.0
    found = []
    for h in hits:
        end = int(round(h / FRAME)) - 5
        if end <= 0 or end >= len(env) or env[end] < 0.05 * top:
            continue
        i = end
        low = env[end]
        while i > 0 and env[i - 1] <= env[i] * 1.05 + 1e-12:
            i -= 1
            low = min(low, env[i])
        if (end - i) * FRAME >= min_len and env[end] >= 2 * max(low, 1e-9):
            found.append({"t0": round(i * FRAME, 4), "t1": round(h, 4), "land": round(h, 4)})
    return found


def fills(beat_map, hits, onset_bands):
    beats = beat_map["beats"]
    downbeats = beat_map["downbeats"]
    found = []
    for h in hits:
        before = [b for b in beats if b < h - 0.03]
        if before:
            found.append((round(before[-1], 4), round(h, 4)))
    # Bars whose last half breaks the pattern: its onsets, by band and sixteenth.
    signatures = []
    for k in range(len(downbeats) - 1):
        a, b = downbeats[k], downbeats[k + 1]
        mid = (a + b) / 2
        sixteenth = (b - a) / 16
        sig = frozenset(
            (name, int(round((t - mid) / sixteenth)))
            for name, times in onset_bands.items()
            for t in times
            if mid - 0.03 <= t < b - 0.03
        )
        signatures.append((mid, b, sig))
    if len(signatures) >= 3:
        usual, _ = Counter(s for _, _, s in signatures).most_common(1)[0]
        for mid, b, sig in signatures:
            if sig != usual and len(sig) > len(usual):
                found.append((round(mid, 4), round(b, 4)))
    return [{"t0": a, "t1": b} for a, b in sorted(set(found))]


def vocal_entries(vocals, rate):
    peak = np.max(np.abs(vocals)) if len(vocals) else 0.0
    if peak <= 0:
        return []
    level = peak * 10 ** (SILENCE_DB / 20)
    env = audio.envelope(vocals, rate, FRAME, 0.02)
    hop = max(1, int(round(FRAME * rate)))
    loud = env >= level * 0.5
    entries = []
    quiet_run = SILENCE_MIN  # the start of the file counts as silence
    for i, on in enumerate(loud):
        if on:
            if quiet_run >= SILENCE_MIN:
                a = max(0, (i - 2) * hop)
                b = min(len(vocals), (i + 3) * hop)
                over = np.flatnonzero(np.abs(vocals[a:b]) >= level)
                if len(over):
                    entries.append(round((a + int(over[0])) / rate, 4))
            quiet_run = 0.0
        else:
            quiet_run += FRAME
    return entries


def read_beats(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        beats = [float(b) for b in data["beats"]]
        downbeats = [float(b) for b in data["downbeats"]]
        return {"beats": beats, "downbeats": downbeats}
    except (OSError, ValueError, KeyError, TypeError):
        refuse(["--beats is not a beats.json"])


def main(argv) -> int:
    job = spec(argv)
    folder = job["stems"]
    for name in ("drums.wav", "vocals.wav"):
        if not os.path.isfile(os.path.join(folder, name)):
            refuse([f"--stems has no {name}"])
    audio.check(os.path.join(folder, "drums.wav"), "--stems drums.wav")
    audio.check(os.path.join(folder, "vocals.wav"), "--stems vocals.wav")
    audio.check(job["mix"], "--mix")
    beat_map = read_beats(job["beats"]) if job.get("beats") else None
    present = {n: os.path.isfile(os.path.join(folder, f"{n}.wav")) for n in ("bass", "other")}
    for n, here in present.items():
        if here:
            audio.check(os.path.join(folder, f"{n}.wav"), f"--stems {n}.wav")

    with quiet():
        rate = audio.RATE
        drums = audio.read(os.path.join(folder, "drums.wav"), rate)
        vocals = audio.read(os.path.join(folder, "vocals.wav"), rate)
        mix = audio.read(job["mix"], rate)
        bass = audio.read(os.path.join(folder, "bass.wav"), rate) if present["bass"] else None
        other = audio.read(os.path.join(folder, "other.wav"), rate) if present["other"] else None
        n = max(len(mix), len(drums))
        fit = lambda x: np.pad(x, (0, max(0, n - len(x))))[:n]  # noqa: E731
        drums, vocals, mix = fit(drums), fit(vocals), fit(mix)
        bass = fit(bass) if bass is not None else None
        other = fit(other) if other is not None else None
        duration = n / rate

        kick, snare, hat = bands(drums, rate)
        onset_times = np.sort(np.concatenate([kick, snare, hat]))
        hits = impacts(mix, drums, bass, rate, onset_times)
        if beat_map and len(beat_map["beats"]) >= 2:
            min_len = 2 * float(np.median(np.diff(beat_map["beats"])))
        else:
            min_len = 1.0
        if bass is not None or other is not None:
            rising_signal = (bass if bass is not None else 0) + (other if other is not None else 0)
        else:
            rising_signal = mix - drums
        found_risers = risers(rising_signal, rate, [t for t, _ in hits], min_len)
        found_fills = fills(beat_map, [t for t, _ in hits], {"kick": kick, "snare": snare, "hat": hat}) if beat_map else []
        entries = vocal_entries(vocals, rate)
        frames = int(np.ceil(duration * 24 - 1e-9))

        def env24(x):
            if x is None:
                return [0.0] * frames
            e = audio.frame_rms(x, rate, 24, frames)
            top = e.max()
            return [round(float(v), 3) for v in (e / top if top > 0 else e)]

        r = lambda ts: [round(float(t), 4) for t in ts]  # noqa: E731
        result = {
            "kick": r(kick),
            "snare": r(snare),
            "hat": r(hat),
            "hits": [{"t": round(t, 4), "score": round(s, 3)} for t, s in hits],
            "risers": found_risers,
            "fills": found_fills,
            "vocal_entries": entries,
            "env24": {"drums": env24(drums), "vocals": env24(vocals), "bass": env24(bass)},
        }
    done({
        "hits_json": result,
        "used": ["drums.wav", "vocals.wav"] + [f"{k}.wav" for k, v in present.items() if v],
        "absent": [f"{k}.wav" for k, v in present.items() if not v],
        "duration": round(duration, 4),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
