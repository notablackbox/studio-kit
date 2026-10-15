"""The four sounds film:mix places under the picture's events, synthesised, never recorded.

    python3 -I src/film/py/film_py/sounds.py --dest <folder>

Run at image build (beside models.py) and by the tests; the WAVs are not committed. Each is
mono, 48 kHz, 24-bit, peak -6 dBFS, the same bytes on every run (a fixed seed):

- tick: a 2.4 kHz sine blip, 35 ms, fast decay (a counter's step, a chart's point);
- stamp: a 110 Hz thump under a short noise burst, 120 ms (a label or a strike landing);
- type: a band of noise 3 to 7 kHz, 18 ms (a terminal or a spec sheet typing in);
- whoosh: noise swept through a band from 300 Hz to 3 kHz and back, 450 ms (a dither).

Prints one JSON document: the files written with their seconds.
"""

import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

RATE = 48000
PEAK = 10 ** (-6 / 20)
SEED = 20261015


def envelope(n, attack, decay):
    t = np.arange(n) / RATE
    a = np.clip(t / max(attack, 1e-6), 0, 1)
    return a * np.exp(-t / decay)


def band(noise, lo, hi):
    spectrum = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(len(noise), 1 / RATE)
    spectrum[(freqs < lo) | (freqs > hi)] = 0
    return np.fft.irfft(spectrum, len(noise))


def norm(x):
    return x / (np.max(np.abs(x)) + 1e-12) * PEAK


def make(rng):
    sounds = {}
    n = int(0.035 * RATE)
    t = np.arange(n) / RATE
    sounds["tick"] = np.sin(2 * np.pi * 2400 * t) * envelope(n, 0.001, 0.008)

    n = int(0.12 * RATE)
    t = np.arange(n) / RATE
    thump = np.sin(2 * np.pi * 110 * t) * envelope(n, 0.002, 0.04)
    burst = band(rng.standard_normal(n), 800, 6000) * envelope(n, 0.0005, 0.012)
    sounds["stamp"] = thump + 0.5 * burst / (np.max(np.abs(burst)) + 1e-12)

    n = int(0.018 * RATE)
    sounds["type"] = band(rng.standard_normal(n), 3000, 7000) * envelope(n, 0.0005, 0.004)

    n = int(0.45 * RATE)
    t = np.arange(n) / RATE
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    # The sweep, in 30 ms slices of band-passed noise whose centre rises then falls.
    step = int(0.03 * RATE)
    for start in range(0, n, step):
        u = start / n
        centre = 300 * (10 ** (1 - abs(2 * u - 1)))
        piece = band(noise[start : start + step * 2], centre * 0.6, centre * 1.6)[:step]
        out[start : start + len(piece)] += piece
    shape = np.sin(np.pi * t / t[-1]) ** 2
    sounds["whoosh"] = out * shape
    return {k: norm(v) for k, v in sounds.items()}


def main(argv):
    parser = argparse.ArgumentParser(prog="sounds.py")
    parser.add_argument("--dest", required=True)
    args = parser.parse_args(argv)
    os.makedirs(args.dest, exist_ok=True)
    written = {}
    for name, samples in make(np.random.default_rng(SEED)).items():
        path = os.path.join(args.dest, f"{name}.wav")
        sf.write(path, samples.astype(np.float64), RATE, subtype="PCM_24")
        written[name] = {"file": f"{name}.wav", "seconds": round(len(samples) / RATE, 4)}
    json.dump({"rate": RATE, "bits": 24, "sounds": written}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
