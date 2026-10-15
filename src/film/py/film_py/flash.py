"""The flash check behind film:flash (claudia.gallery's toolkit wiki, item 21; WCAG 2.3.1).

    python3 -I -m film_py.flash '<spec>'

The spec is the one argument, JSON: {"raw": path, "width": 96, "height": 54, "fps": 24}. The
raw file holds the video decoded by ffmpeg at 96x54 and 24 fps as rgb24 frames.

- Each pixel's linear relative luminance (sRGB decoded, Rec. 709 weights), 0 to 1; each frame's
  mean.
- A transition is a run of frames whose mean moves one way (steps under 0.002 continue the run)
  by at least 0.1 in all, where the darker end is under 0.8 and at least a quarter of the frame's
  pixels moved by 0.1 or more the same way (WCAG's general flash threshold, simplified to the
  frame's mean and a quarter of its area).
- A flash is a pair of opposing transitions, counted at the second one; pairs, not transitions.
- Any one-second window (24 frames) holding more than three flashes fails.
- A single-frame pop is a frame whose mean differs from both neighbours in the same direction by
  more than 0.03 (a lit rim rushing past the lens). Pops are flagged as warnings, never failed:
  only the flash count fails.

The result: frames, the mean luminance per frame (rounded), transitions, flashes, the worst
window, the failing windows and the pops.
"""

import sys

import numpy as np

from film_py import done, refuse, spec

STEP = 0.1
DARK = 0.8
AREA = 0.25
POP = 0.03
FLAT = 0.002
MAX_FLASHES = 3


def linear(rgb):
    c = rgb.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def transitions(lum, means):
    """Monotonic runs of the mean, kept when they pass the WCAG thresholds."""
    found = []
    n = len(means)
    start = 0
    k = 1
    while k < n:
        direction = np.sign(means[k] - means[k - 1]) if abs(means[k] - means[k - 1]) >= FLAT else 0
        if direction == 0:
            start = k
            k += 1
            continue
        end = k
        while end + 1 < n and (means[end + 1] - means[end]) * direction >= FLAT:
            end += 1
        change = means[end] - means[start]
        darker = min(means[start], means[end])
        moved = (lum[end] - lum[start]) * direction
        area = float(np.mean(moved >= STEP))
        if abs(change) >= STEP and darker < DARK and area >= AREA:
            found.append({"from": int(start), "to": int(end), "dir": int(direction), "change": round(float(change), 4), "area": round(area, 3)})
        start = end
        k = end + 1
    return found


def main():
    job = spec(sys.argv[1:])
    width, height, fps = int(job["width"]), int(job["height"]), int(job["fps"])
    data = np.fromfile(job["raw"], dtype=np.uint8)
    size = width * height * 3
    if data.size < size:
        refuse(["--video has no frames"])
    frames = data[: (data.size // size) * size].reshape(-1, height, width, 3)
    lum = linear(frames)
    means = lum.reshape(len(lum), -1).mean(axis=1)

    found = transitions(lum, means)
    # Count pairs, not transitions: each transition belongs to at most one flash.
    flashes = []
    used = set()
    for i in range(1, len(found)):
        if found[i]["dir"] != found[i - 1]["dir"] and (i - 1) not in used:
            used.add(i)
            flashes.append({"frame": found[i]["to"], "t": round(found[i]["to"] / fps, 4)})

    windows = []
    worst = {"t0": 0.0, "count": 0}
    times = [f["frame"] for f in flashes]
    for start in range(0, max(1, len(means))):
        count = sum(1 for f in times if start <= f < start + fps)
        if count > worst["count"]:
            worst = {"t0": round(start / fps, 4), "count": count}
        if count > MAX_FLASHES:
            windows.append({"t0": round(start / fps, 4), "t1": round((start + fps) / fps, 4), "flashes": count})
    # One line per failing stretch: windows that overlap are merged.
    merged = []
    for w in windows:
        if merged and w["t0"] <= merged[-1]["t1"]:
            merged[-1]["t1"] = w["t1"]
            merged[-1]["flashes"] = max(merged[-1]["flashes"], w["flashes"])
        else:
            merged.append(dict(w))

    pops = []
    for k in range(1, len(means) - 1):
        d0 = means[k] - means[k - 1]
        d1 = means[k] - means[k + 1]
        if d0 * d1 > 0 and abs(d0) > POP and abs(d1) > POP:
            pops.append({"frame": k, "t": round(k / fps, 4), "mean": round(float(means[k]), 4), "before": round(float(means[k - 1]), 4), "after": round(float(means[k + 1]), 4)})

    done({
        "frames": int(len(means)),
        "fps": fps,
        "mean": [round(float(m), 4) for m in means],
        "transitions": found,
        "flashes": flashes,
        "worst": worst,
        "windows": merged,
        "pops": pops,
        "ok": not merged,
    })


if __name__ == "__main__":
    main()
