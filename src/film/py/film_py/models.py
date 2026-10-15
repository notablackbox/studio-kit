"""Downloads the film engine's model weights into one folder, once, at image build.

    python3 -I src/film/py/film_py/models.py --dest /opt/models [--only depth,mms_fa]
    python3 -I -m film_py.models --dest /opt/models      (where film_py is on the path)

It needs the network and the pinned requirements; no model needs a token. Each model lands
in its own place under --dest, and `models.json` there lists every model with its source,
revision, files, sizes, sha256 and the seconds its download took. A model that cannot be
fetched is listed with `status: "missing"` and the reason, and nothing is put in its place;
the commands that need it refuse with exit 2. The exit code is 0 when every model asked for
is in place, 1 otherwise.

This file imports nothing from film_py, so it runs as a plain file under `python3 -I`.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

MANIFEST = "models.json"

DEPTH_REPO = "depth-anything/Depth-Anything-V2-Small-hf"
DEPTH_REVISION = "5426e4f0f36572d16453bbda7a8389317b1bef99"
WHISPER_REPO = "Systran/faster-whisper-tiny"
WHISPER_REVISION = "d90ca5fe260221311c53c58e660288d3deb8d356"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def listing(root: Path) -> set:
    return {p for p in root.rglob("*") if p.is_file()} if root.exists() else set()


def describe(dest: Path, files) -> list:
    # Each stored file once: the Hugging Face cache's snapshot links point at its blobs, and
    # its lock files hold nothing.
    return [
        {"file": str(p.relative_to(dest)), "bytes": p.stat().st_size, "sha256": sha256(p)}
        for p in sorted(files)
        if not p.is_symlink() and p.suffix != ".lock"
    ]


def use_dest(dest: Path) -> None:
    # The same places film_py.offline() points the commands at.
    os.environ["HF_HOME"] = str(dest / "hf")
    os.environ["TORCH_HOME"] = str(dest / "torch")
    import torch

    torch.hub.set_dir(str(dest / "torch" / "hub"))


def fetch_depth(dest: Path) -> dict:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    target = dest / "depth-anything-v2-small"
    with tempfile.TemporaryDirectory(dir=dest) as cache:
        staging = Path(cache) / "out"
        AutoImageProcessor.from_pretrained(DEPTH_REPO, revision=DEPTH_REVISION, cache_dir=cache).save_pretrained(staging)
        AutoModelForDepthEstimation.from_pretrained(DEPTH_REPO, revision=DEPTH_REVISION, cache_dir=cache).save_pretrained(staging)
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(str(staging), target)
    return {"source": DEPTH_REPO, "revision": DEPTH_REVISION, "path": target.name, "files": describe(dest, listing(target))}


def fetch_hub(dest: Path, load, source: str) -> dict:
    # torch hub's cache, and the Hugging Face cache for a loader that fetches from there.
    roots = [dest / "torch", dest / "hf"]
    before = set().union(*(listing(r) for r in roots))
    load()
    new = set().union(*(listing(r) for r in roots)) - before
    weights = sorted((p for p in new if p.suffix in (".pt", ".th", ".pth", ".bin", ".safetensors")), key=lambda p: -p.stat().st_size)
    if not weights:
        # Already present from an earlier run: find it again by name.
        raise RuntimeError("no new weight file appeared (already downloaded? remove --dest and run again)")
    return {"source": source, "revision": None, "path": str(weights[0].relative_to(dest)), "files": describe(dest, new)}


def fetch_mms_fa(dest: Path) -> dict:
    import torchaudio

    bundle = torchaudio.pipelines.MMS_FA
    return fetch_hub(dest, lambda: bundle.get_model(), "torchaudio.pipelines.MMS_FA")


def fetch_htdemucs(dest: Path) -> dict:
    from demucs.pretrained import get_model

    return fetch_hub(dest, lambda: get_model("htdemucs"), "demucs.pretrained htdemucs")


def fetch_whisper_tiny(dest: Path) -> dict:
    from faster_whisper.utils import download_model

    target = dest / "faster-whisper-tiny"
    with tempfile.TemporaryDirectory(dir=dest) as cache:
        staging = Path(cache) / "out"
        download_model(WHISPER_REPO, output_dir=str(staging), cache_dir=cache, revision=WHISPER_REVISION)
        for leftover in staging.glob(".cache"):
            shutil.rmtree(leftover, ignore_errors=True)
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(str(staging), target)
    return {"source": WHISPER_REPO, "revision": WHISPER_REVISION, "path": target.name, "files": describe(dest, listing(target))}


FETCHERS = {
    "depth": fetch_depth,
    "mms_fa": fetch_mms_fa,
    "htdemucs": fetch_htdemucs,
    "whisper_tiny": fetch_whisper_tiny,
}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Download the film engine's model weights.")
    parser.add_argument("--dest", required=True)
    parser.add_argument("--only", default=",".join(FETCHERS))
    args = parser.parse_args(argv)
    keys = [k for k in args.only.split(",") if k]
    unknown = [k for k in keys if k not in FETCHERS]
    if unknown:
        print(f"unknown model {unknown[0]!r}, want one of {', '.join(FETCHERS)}")
        return 2

    dest = Path(args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    manifest_path = dest / MANIFEST
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {"version": 1, "models": {}}
    use_dest(dest)

    missing = 0
    for key in keys:
        started = time.monotonic()
        try:
            entry = FETCHERS[key](dest)
            entry["status"] = "ok"
        except Exception as error:  # noqa: BLE001  (any failure is recorded, never invented around)
            entry = {"status": "missing", "reason": f"{type(error).__name__}: {error}"[:500], "path": None, "files": []}
            missing += 1
        entry["seconds"] = round(time.monotonic() - started, 1)
        manifest["models"][key] = entry
        size = sum(f["bytes"] for f in entry["files"]) / 1e6
        reason = f" ({entry['reason']})" if "reason" in entry else ""
        print(f"model {key}: {entry['status']}, {size:.1f} MB, {entry['seconds']} s{reason}")
        sys.stdout.flush()
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
