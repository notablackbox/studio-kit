"""The sync check: how much of a sung take copies the clean vocal window it was given.

claudia.gallery's toolkit wiki, item 15, as the kit rules it: both signals (decoded by the Node
side to 16 kHz mono) become log-mel spectrograms (10 ms hop, 64 ms Hann frames, 80 bands from
50 to 7,600 Hz, a 70 dB floor under each signal's peak). The global lag is the shift within
plus or minus 1.0 s that maximises the normalised cross-correlation (NCC) of the two mel
envelopes, each band's mean removed over the overlap; that peak is the take's NCC. With the
window placed on the take at that lag, the NCC is measured again over time, in 0.5 s windows
stepped by one frame. A 0.5 s window is judged when at least a quarter of its frames are
active in either signal (frame RMS over 10 percent of that signal's 95th percentile); a window
of silence in both is not judged and bridges a span. The in-sync spans are the runs of judged
windows over 0.2 (from the first one's start to the last one's end, never past the next failing
window's start, at least 0.5 s); the divergence is the start of the first judged window at or
under 0.2. A take that ends before the window does, while our window still holds voice, diverges
from the take's end at the latest: the missing tail is not in sync. Times are seconds from the
window file's start; the Node side maps them to song time
and finds the cut. A diagnostic PNG shows both spectrograms on the window's timeline and the
NCC curve with its threshold.

numpy, soundfile and pillow only.
"""

import sys
from pathlib import Path

import numpy as np

from film_py import done, quiet, refuse, spec

RATE = 16000
HOP = 160
NFFT = 1024
BANDS = 80
FMIN = 50.0
FMAX = 7600.0
FLOOR_DB = 70.0
MAX_LAG = 100  # frames: 1.0 s
SPAN = 50  # frames: 0.5 s
THRESHOLD = 0.2
ACTIVE = 0.1
JUDGED = 0.25


def mel_bank() -> np.ndarray:
    """Triangular filters on the HTK mel scale, BANDS by NFFT/2+1."""
    def mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def hz(m):
        return 700.0 * (10 ** (m / 2595.0) - 1.0)

    edges = hz(np.linspace(mel(FMIN), mel(FMAX), BANDS + 2))
    freqs = np.fft.rfftfreq(NFFT, 1.0 / RATE)
    bank = np.zeros((BANDS, len(freqs)))
    for b in range(BANDS):
        lo, mid, hi = edges[b], edges[b + 1], edges[b + 2]
        rise = (freqs - lo) / max(mid - lo, 1e-9)
        fall = (hi - freqs) / max(hi - mid, 1e-9)
        bank[b] = np.clip(np.minimum(rise, fall), 0.0, None)
    return bank


def analyse(x: np.ndarray, bank: np.ndarray):
    """The log-mel spectrogram (frames by bands) and the RMS of each frame."""
    frames = len(x) // HOP + 1
    padded = np.concatenate([np.zeros(NFFT // 2), x, np.zeros(NFFT)])
    index = np.arange(frames)[:, None] * HOP + np.arange(NFFT)[None, :]
    chunks = padded[index]
    window = np.hanning(NFFT)
    power = np.abs(np.fft.rfft(chunks * window, axis=1)) ** 2
    db = 10.0 * np.log10(power @ bank.T + 1e-12)
    db = np.maximum(db, db.max() - FLOOR_DB)
    rms = np.sqrt(np.mean(chunks[:, NFFT // 2 - HOP // 2: NFFT // 2 + HOP // 2] ** 2, axis=1))
    return db, rms


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    """Normalised cross-correlation of two equal patches, each band's mean removed."""
    a = a - a.mean(axis=0, keepdims=True)
    b = b - b.mean(axis=0, keepdims=True)
    den = np.sqrt(np.sum(a * a) * np.sum(b * b))
    return float(np.sum(a * b) / den) if den > 1e-9 else 0.0


def read(path: str) -> np.ndarray:
    import soundfile as sf  # noqa: PLC0415

    data, rate = sf.read(path, dtype="float64", always_2d=True)
    if rate != RATE:
        refuse([f"{path} is not at {RATE} Hz"])
    return data.mean(axis=1)


def picture(path: Path, ref: np.ndarray, take: np.ndarray, curve: np.ndarray, judged: np.ndarray, diverge):
    """Our window's spectrogram, the take's on the same timeline, and the NCC over time."""
    from PIL import Image, ImageDraw  # noqa: PLC0415

    def shade(db):
        lo, hi = db.min(), db.max()
        v = (db - lo) / max(hi - lo, 1e-9)
        return (255 * v[:, ::-1].T).astype(np.uint8)  # low bands at the bottom

    width = ref.shape[0]
    rows = 2 * BANDS
    plot = 120
    gap = 6
    height = 2 * rows + plot + 2 * gap
    canvas = Image.new("RGB", (width, height), (16, 16, 16))
    for k, db in enumerate((ref, take)):
        tile = Image.fromarray(shade(db), "L").resize((width, rows), Image.NEAREST)
        canvas.paste(Image.merge("RGB", (tile, tile, tile)), (0, k * (rows + gap)))
    draw = ImageDraw.Draw(canvas)
    top = 2 * (rows + gap)

    def y(v):
        return top + int(round((1.0 - (max(-1.0, min(1.0, v)) + 1.0) / 2.0) * (plot - 1)))

    draw.line([(0, y(THRESHOLD)), (width - 1, y(THRESHOLD))], fill=(120, 120, 120))
    draw.line([(0, y(0.0)), (width - 1, y(0.0))], fill=(60, 60, 60))
    for i in range(1, len(curve)):
        colour = (217, 119, 87) if judged[i] else (90, 90, 90)
        draw.line([(i - 1, y(curve[i - 1])), (i, y(curve[i]))], fill=colour)
    if diverge is not None:
        draw.line([(diverge, 0), (diverge, height - 1)], fill=(230, 40, 40))
    canvas.save(path, format="PNG")


def main(argv) -> None:
    job = spec(argv)
    with quiet():
        bank = mel_bank()
        ref_x = read(job["window"])
        take_x = read(job["take"])
        if len(ref_x) < SPAN * HOP or len(take_x) < SPAN * HOP:
            refuse(["--take and --window must each hold at least 0.5 s of audio"])
        ref, ref_rms = analyse(ref_x, bank)
        take, take_rms = analyse(take_x, bank)
        nr, nt = len(ref), len(take)

        # The global lag: take frame i + lag holds window frame i.
        best_lag, best = 0, -2.0
        for lag in range(-MAX_LAG, MAX_LAG + 1):
            i0, i1 = max(0, -lag), min(nr, nt - lag)
            if i1 - i0 < SPAN:
                continue
            value = ncc(ref[i0:i1], take[i0 + lag: i1 + lag])
            if value > best + 1e-12:
                best_lag, best = lag, value

        # The NCC over time, on the window's timeline.
        ref_on = ref_rms > ACTIVE * np.percentile(ref_rms, 95)
        take_on = take_rms > ACTIVE * np.percentile(take_rms, 95)
        starts = [i for i in range(0, nr - SPAN + 1) if 0 <= i + best_lag and i + best_lag + SPAN <= nt]
        curve = np.zeros(nr)
        judged = np.zeros(nr, dtype=bool)
        for i in starts:
            j = i + best_lag
            active = np.logical_or(ref_on[i: i + SPAN], take_on[j: j + SPAN]).mean()
            judged[i] = active >= JUDGED
            curve[i] = ncc(ref[i: i + SPAN], take[j: j + SPAN])

        hop_s = HOP / RATE
        diverge = next((i for i in starts if judged[i] and curve[i] <= THRESHOLD), None)
        # The window frame where the take runs out; voice of ours after it was never copied.
        take_end = nt - best_lag
        missing = 0.0
        if 0 <= take_end < nr and ref_on[take_end:].any():
            missing = (nr - take_end) * hop_s
            diverge = take_end if diverge is None else min(diverge, take_end)
        spans = []
        first = last = None
        for i in starts + [None]:
            failing = i is not None and judged[i] and curve[i] <= THRESHOLD
            if i is not None and judged[i] and not failing:
                first = i if first is None else first
                last = i
                continue
            if failing or i is None:
                if first is not None:
                    end = last + SPAN
                    if i is not None:
                        end = min(end, i)
                    if (end - first) * hop_s >= 0.5:
                        spans.append([round(first * hop_s, 4), round(end * hop_s, 4)])
                first = last = None

        png = Path(job["dest"]) / job["png"]
        picture(png, ref, np.array([take[min(max(i + best_lag, 0), nt - 1)] for i in range(nr)]), curve, judged, diverge)

    done(
        {
            "lag_s": round(best_lag * hop_s, 4),
            "ncc": round(best, 4),
            "frames": {"window": nr, "take": nt, "hop_s": hop_s},
            "synced": spans,
            "diverge_at": None if diverge is None else round(diverge * hop_s, 4),
            "missing_tail_s": round(missing, 4),
            "curve_t0_s": round(starts[0] * hop_s, 4) if starts else 0.0,
            "judged": int(judged.sum()),
            "curve": [round(float(curve[i]), 3) if judged[i] else None for i in starts[::5]],
            "curve_step_s": round(5 * hop_s, 4),
            "png": job["png"],
        }
    )


if __name__ == "__main__":
    main(sys.argv[1:])
