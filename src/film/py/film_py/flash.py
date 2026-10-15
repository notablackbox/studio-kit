"""The flash check behind film:flash (claudia.gallery's toolkit wiki, item 21; WCAG 2.3.1).

    python3 -I -m film_py.flash '<spec>'

The spec is the one argument, JSON: {"raw": path, "width": 96, "height": 54, "fps": 24}. The
raw file holds the video decoded by ffmpeg at 96x54 and 24 fps as rgb24 frames.

- Each pixel's linear relative luminance (sRGB decoded, Rec. 709 weights), 0 to 1; each frame's
  mean.
- WCAG 2.3.1's general flash is a pair of opposing changes in relative luminance of 0.1 or more
  where the darker image is under 0.8, over an area large enough (a quarter of any 10 degree
  field of view). Here the area is a quarter of the frame, and the change is measured per pixel,
  not on the frame's mean: a quarter of the frame flashing moves the mean by only a quarter as
  much.
- The candidate stretches are the runs of frames whose mean moves one way (each step 0.002 or
  more; a smaller step ends the run), however little the mean moves in all. A run is a transition
  when, between its first and last frame, at least a quarter of the frame's pixels changed by 0.1
  or more in the run's direction with the darker of their two values under 0.8.
- What this does not see: two regions changing the opposite ways at once, so that the mean
  stays within 0.002 a frame (each region's change is still caught when the mean moves with it).
- A flash is a pair of opposing transitions, counted at the second one; pairs, not transitions.
- Any one-second window (24 frames) holding more than three flashes fails.
- The red flash, which WCAG defines apart from the general one: a pixel is saturated red when
  R / (R + G + B) >= 0.8 (the 8-bit sRGB values; black is not red). Each frame's red fraction is
  the share of its pixels that are saturated red; a red transition is a run of that fraction one
  way (steps under 0.002 continue the run) by at least a quarter of the frame, the general
  flash's area. Red flashes are pairs of opposing red transitions, counted and windowed the same
  way, and more than three in any second fails too, whatever the luminance does (saturated red
  against a gray of equal luminance flashes for the eye but not for the mean).
- A single-frame pop is a frame whose mean differs from both neighbours in the same direction by
  more than 0.03 (a lit rim rushing past the lens). Pops are flagged as warnings, never failed:
  only the flash counts fail.

The result: frames, the mean luminance and red fraction per frame (rounded), transitions,
flashes, the worst window, the failing windows (each for the general and the red flash) and the
pops.
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
RED = 0.8


def linear(rgb):
    c = rgb.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def saturated_red(rgb):
    """Per pixel: R / (R + G + B) >= 0.8, on the 8-bit values (black, all zero, is not red)."""
    c = rgb.astype(np.float64)
    total = c.sum(axis=-1)
    return (total > 0) & (c[..., 0] >= RED * total)


def runs(series):
    """Monotonic runs of a per-frame series: (start, end, direction), steps under FLAT end a run."""
    n = len(series)
    start = 0
    k = 1
    while k < n:
        direction = np.sign(series[k] - series[k - 1]) if abs(series[k] - series[k - 1]) >= FLAT else 0
        if direction == 0:
            start = k
            k += 1
            continue
        end = k
        while end + 1 < n and (series[end + 1] - series[end]) * direction >= FLAT:
            end += 1
        yield start, end, int(direction)
        start = end
        k = end + 1


def transitions(lum, means):
    """Monotonic runs of the mean, kept when a quarter of the pixels pass WCAG's thresholds.

    Per pixel, between the run's first and last frame: a change of 0.1 or more in the run's
    direction, the darker of the two values under 0.8. `change` is the mean's (for the report);
    `area` the share of pixels that qualified.
    """
    found = []
    for start, end, direction in runs(means):
        first, last = lum[start], lum[end]
        moved = (last - first) * direction
        qualifies = (moved >= STEP) & (np.minimum(first, last) < DARK)
        area = float(np.mean(qualifies))
        if area >= AREA:
            change = means[end] - means[start]
            found.append({"from": int(start), "to": int(end), "dir": direction, "change": round(float(change), 4), "area": round(area, 3)})
    return found


def red_transitions(red):
    """Monotonic runs of the red fraction that change it by a quarter of the frame or more."""
    found = []
    for start, end, direction in runs(red):
        change = red[end] - red[start]
        if abs(change) >= AREA:
            found.append({"from": int(start), "to": int(end), "dir": direction, "change": round(float(change), 4)})
    return found


def pairs(found, fps):
    """Flashes: pairs of opposing transitions, each transition in at most one, at the second."""
    flashes = []
    used = set()
    for i in range(1, len(found)):
        if found[i]["dir"] != found[i - 1]["dir"] and (i - 1) not in used:
            used.add(i)
            flashes.append({"frame": found[i]["to"], "t": round(found[i]["to"] / fps, 4)})
    return flashes


def windowed(flashes, frames, fps):
    """The worst one-second window and the failing stretches (overlapping windows merged)."""
    windows = []
    worst = {"t0": 0.0, "count": 0}
    times = [f["frame"] for f in flashes]
    for start in range(0, max(1, frames)):
        count = sum(1 for f in times if start <= f < start + fps)
        if count > worst["count"]:
            worst = {"t0": round(start / fps, 4), "count": count}
        if count > MAX_FLASHES:
            windows.append({"t0": round(start / fps, 4), "t1": round((start + fps) / fps, 4), "flashes": count})
    merged = []
    for w in windows:
        if merged and w["t0"] <= merged[-1]["t1"]:
            merged[-1]["t1"] = w["t1"]
            merged[-1]["flashes"] = max(merged[-1]["flashes"], w["flashes"])
        else:
            merged.append(dict(w))
    return worst, merged


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
    red = saturated_red(frames).reshape(len(frames), -1).mean(axis=1)

    found = transitions(lum, means)
    flashes = pairs(found, fps)
    worst, merged = windowed(flashes, len(means), fps)
    red_found = red_transitions(red)
    red_flashes = pairs(red_found, fps)
    red_worst, red_merged = windowed(red_flashes, len(means), fps)

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
        "red": [round(float(r), 4) for r in red],
        "red_transitions": red_found,
        "red_flashes": red_flashes,
        "red_worst": red_worst,
        "red_windows": red_merged,
        "pops": pops,
        "ok": not merged and not red_merged,
    })


if __name__ == "__main__":
    main()
