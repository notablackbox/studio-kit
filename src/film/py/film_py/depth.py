"""A plate's depth map and its three soft mattes, behind film:depth (claudia.gallery's toolkit
wiki, item 12, and ruling R3).

    python3 -I -m film_py.depth '<spec>'

The spec is the one argument, JSON (stdin is read only when there is none, which the kit's
runner never does): {"plate": path, "dest": folder, "name": stem}. `dest` is a temporary folder
the Node side made; it moves the files into --out.

- Depth: Depth Anything V2 Small (Apache-2.0) through transformers, on the CPU, from the
  models folder. Its output is relative inverse depth (larger is nearer); it is resized to the
  plate's size (bicubic), scaled to the full 16-bit range and written as `<name>.depth.png`,
  near bright.
- Mattes (R3): the depth map's terciles cut it into far (at or under the 1/3 quantile), near
  (at or over the 2/3 quantile) and mid; each hard mask is blurred with the same separable
  Gaussian, whose ramp spans about 2 percent of the plate's width (sigma = feather / 4, edges
  held), so the three mattes still add up to one everywhere. Written as 8-bit greys
  `<name>.near.png`, `<name>.mid.png`, `<name>.far.png`.
- Boxes: faces and persons need a detector (the wiki uses Grounding DINO); the image has none,
  so `<name>.boxes.json` holds empty lists, `detector: null` and a note.
"""

import json
import os
import sys
import time

import numpy as np

from film_py import done, model, models_dir, offline, quiet, refuse, spec, threads

FEATHER = 0.02  # of the plate's width
TERCILES = (100 / 3, 200 / 3)
MODEL = "Depth Anything V2 Small"


def blur(mask: np.ndarray, sigma: float) -> np.ndarray:
    """A separable Gaussian blur with the edges held (a linear filter: partitions stay partitions)."""
    radius = max(1, int(np.ceil(3 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel /= kernel.sum()
    out = mask.astype(np.float64)
    for axis in (0, 1):
        padded = np.pad(out, [(radius, radius) if a == axis else (0, 0) for a in range(2)], mode="edge")
        acc = np.zeros_like(out)
        for k, w in enumerate(kernel):
            acc += w * (padded[k:k + out.shape[0], :] if axis == 0 else padded[:, k:k + out.shape[1]])
        out = acc
    return out


def main(argv) -> int:
    job = spec(argv)
    path = model("depth")
    from PIL import Image  # noqa: PLC0415

    try:
        with Image.open(job["plate"]) as im:
            im.load()
            plate = im.convert("RGB")
    except (OSError, ValueError):
        refuse(["--plate cannot be read as an image"])
    width, height = plate.size
    started = time.monotonic()
    with quiet():
        offline(models_dir())
        import torch  # noqa: PLC0415
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # noqa: PLC0415

        processor = AutoImageProcessor.from_pretrained(str(path), local_files_only=True)
        net = AutoModelForDepthEstimation.from_pretrained(str(path), local_files_only=True)
        net.eval()
        inputs = processor(images=plate, return_tensors="pt")
        with torch.inference_mode():
            predicted = net(**inputs).predicted_depth
        resized = torch.nn.functional.interpolate(predicted[:, None], size=(height, width), mode="bicubic", align_corners=False)
        raw = resized[0, 0].double().numpy()
    lo, hi = float(raw.min()), float(raw.max())
    depth = (raw - lo) / (hi - lo) if hi > lo else np.zeros_like(raw)
    depth16 = np.round(depth * 65535).astype(np.uint16)

    q1, q2 = np.percentile(depth, TERCILES)
    far = depth <= q1
    near = (depth >= q2) & ~far
    mid = ~far & ~near
    feather = max(1, int(round(FEATHER * width)))
    sigma = feather / 4
    soft = {name: blur(mask, sigma) for name, mask in (("near", near), ("mid", mid), ("far", far))}

    dest = job["dest"]
    name = job["name"]
    files = {"depth": f"{name}.depth.png", "near": f"{name}.near.png", "mid": f"{name}.mid.png", "far": f"{name}.far.png", "boxes": f"{name}.boxes.json"}
    Image.fromarray(depth16).save(os.path.join(dest, files["depth"]), format="PNG")
    for key in ("near", "mid", "far"):
        Image.fromarray(np.clip(np.round(soft[key] * 255), 0, 255).astype(np.uint8)).save(os.path.join(dest, files[key]), format="PNG")
    boxes = {"faces": [], "persons": [], "detector": None, "note": "no face or person detector in the image"}
    with open(os.path.join(dest, files["boxes"]), "w", encoding="utf-8") as f:
        json.dump(boxes, f)
        f.write("\n")
    done({
        "files": files,
        "size": [width, height],
        "model": {"name": MODEL, "path": path.name, "device": "cpu", "threads": threads()},
        "raw_range": [round(lo, 4), round(hi, 4)],
        "terciles": [round(float(q1), 4), round(float(q2), 4)],
        "share": {"near": round(float(near.mean()), 4), "mid": round(float(mid.mean()), 4), "far": round(float(far.mean()), 4)},
        "feather_px": feather,
        "detector": None,
        "seconds": round(time.monotonic() - started, 2),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
