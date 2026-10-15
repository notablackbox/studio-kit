"""Audio helpers the listening modules share: reading, band filters, envelopes and onsets.

numpy and soundfile only (no torch), so the beat map and the hits load fast. Times are seconds.
"""

import numpy as np

from film_py import refuse

RATE = 44100


def check(path: str, flag: str):
    """The file's soundfile info, or a refusal naming the flag when it is not audio."""
    import soundfile as sf  # noqa: PLC0415

    try:
        info = sf.info(path)
    except Exception:  # noqa: BLE001  (any reader error means: not audio we can read)
        refuse([f"{flag} cannot be read as audio"])
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        refuse([f"{flag} cannot be read as audio"])
    return info


def read(path: str, rate: int = RATE, mono: bool = True) -> np.ndarray:
    """The file as float64 samples at `rate`: one row when mono, else channels by samples."""
    import soundfile as sf  # noqa: PLC0415

    data, source_rate = sf.read(path, dtype="float64", always_2d=True)
    x = data.T
    if mono:
        x = x.mean(axis=0, keepdims=True)
    if source_rate != rate:
        x = np.stack([resample(c, source_rate, rate) for c in x])
    return x[0] if mono else x


def resample(x: np.ndarray, source: int, target: int) -> np.ndarray:
    """Band-limited resampling by the FFT (whole signal; fine for a song)."""
    n = len(x)
    m = int(round(n * target / source))
    if m == n or n == 0:
        return x.copy()
    spectrum = np.fft.rfft(x)
    keep = min(len(spectrum), m // 2 + 1)
    out = np.zeros(m // 2 + 1, dtype=complex)
    out[:keep] = spectrum[:keep]
    return np.fft.irfft(out, m) * (m / n)


def band(x: np.ndarray, rate: int, low: float, high: float) -> np.ndarray:
    """x band-passed between low and high Hz, with raised-cosine edges a fifth of an octave wide."""
    n = len(x)
    size = 1 << max(1, int(np.ceil(np.log2(max(n, 2)))))
    spectrum = np.fft.rfft(x, size)
    f = np.fft.rfftfreq(size, 1 / rate)
    gain = np.ones_like(f)
    for edge, rising in ((low, True), (high, False)):
        if edge <= 0 or edge >= rate / 2:
            continue
        a, b = edge / 2 ** 0.1, edge * 2 ** 0.1
        ramp = np.clip((np.log2(np.maximum(f, 1e-9)) - np.log2(a)) / (np.log2(b) - np.log2(a)), 0, 1)
        shape = 0.5 - 0.5 * np.cos(np.pi * ramp)
        gain *= shape if rising else 1 - shape
    return np.fft.irfft(spectrum * gain, size)[:n]


def envelope(x: np.ndarray, rate: int, hop: float, window: float, causal: bool = False) -> np.ndarray:
    """RMS per hop: over the `window` seconds ending at each hop (causal) or centred on it."""
    hop_n = max(1, int(round(hop * rate)))
    win_n = max(1, int(round(window * rate)))
    energy = np.concatenate([[0.0], np.cumsum(x * x)])
    frames = int(np.ceil(len(x) / hop_n))
    centre = np.arange(frames) * hop_n
    start = centre - (win_n if causal else win_n // 2)
    stop = start + win_n
    start = np.clip(start, 0, len(x))
    stop = np.clip(stop, 0, len(x))
    width = np.maximum(stop - start, 1)
    return np.sqrt(np.maximum(energy[stop] - energy[start], 0) / width)


def frame_rms(x: np.ndarray, rate: int, fps: float, frames: int) -> np.ndarray:
    """RMS of each 1/fps slice [i/fps, (i+1)/fps), `frames` of them."""
    energy = np.concatenate([[0.0], np.cumsum(x * x)])
    edges = np.clip(np.round(np.arange(frames + 1) / fps * rate).astype(int), 0, len(x))
    width = np.maximum(np.diff(edges), 1)
    return np.sqrt(np.maximum(np.diff(energy[edges]), 0) / width)


def onsets(x: np.ndarray, rate: int, low: float = 0, high: float = 0, floor_db: float = -30.0):
    """Onsets in a band of x: (times, strengths).

    The band's RMS envelope every 1 ms over the 1.5 periods of its lowest frequency (5 to 25 ms,
    so a low sine does not ripple it); a rise is the envelope against its own minimum over the
    previous 30 ms. Peaks of the rise at least 30 ms apart that reach 15 percent of the
    strongest rise within 4 s, and `floor_db` of the strongest in the file, are onsets. Each is
    timed where the envelope last crossed a quarter of the way from that minimum to the peak
    that follows, less the window's own lag (a sixteenth of it, for a step in level).
    """
    y = band(x, rate, low, high) if (low or high) else x
    hop = max(1, int(round(0.001 * rate))) / rate  # a whole number of samples, so times do not drift
    window = min(0.025, max(0.005, 1.5 / low)) if low else 0.01
    env = envelope(y, rate, hop, window, causal=True)
    n = len(env)
    if n < 40 or env.max() <= 0:
        return np.zeros(0), np.zeros(0)
    back = 30
    padded = np.concatenate([np.full(back, env[0]), env])
    lows = np.lib.stride_tricks.sliding_window_view(padded, back + 1)[:n].min(axis=1)
    rise = env - lows
    # Peaks: the largest rise within 30 ms either side.
    radius = 30
    padded_rise = np.concatenate([np.zeros(radius), rise, np.zeros(radius)])
    local_max = np.lib.stride_tricks.sliding_window_view(padded_rise, 2 * radius + 1).max(axis=1)
    strongest = rise.max()
    region = 4000
    padded_rise = np.concatenate([np.zeros(region), rise, np.zeros(region)])
    # The strongest rise within 4 s, on a coarse 50 ms grid for speed.
    coarse = np.array([padded_rise[max(0, i):i + 2 * region + 1].max() for i in range(0, n, 50)])
    regional = np.repeat(coarse, 50)[:n]
    floor = strongest * 10 ** (floor_db / 20)
    candidates = np.flatnonzero((rise >= local_max) & (rise > 0) & (rise >= 0.15 * regional) & (rise >= floor))
    times, strengths = [], []
    last = -1e9
    for i in candidates:
        if i - last < 30:
            continue
        last = i
        start = max(0, i - back)
        base = env[start:i + 1].min()
        peak_at = min(n, i + int(window / hop) + 5)
        top = env[i:peak_at].max()
        level = base + 0.25 * (top - base)
        below = np.flatnonzero(env[start:i + 1] < level)
        j = start + (int(below[-1]) + 1 if len(below) else 0)
        times.append(max(0.0, j * hop - window / 16))
        strengths.append(top)
    return np.array(times), np.array(strengths)


def near(times: np.ndarray, t: float, radius: float):
    """The index of the time in `times` (sorted) nearest to t within radius, or None."""
    if len(times) == 0:
        return None
    k = int(np.searchsorted(times, t))
    best = None
    for j in (k - 1, k):
        if 0 <= j < len(times) and abs(times[j] - t) <= radius and (best is None or abs(times[j] - t) < abs(times[best] - t)):
            best = j
    return best
