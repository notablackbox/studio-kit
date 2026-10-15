"""The four stems behind film:stems (claudia.gallery's toolkit wiki, item 4).

    python3 -I -m film_py.stems '<spec>'

The spec is the one argument, JSON (stdin is read only when there is none, which the kit's
runner never does): {"in": path, "dest": folder}. demucs htdemucs on the CPU, all four sources (never
two-stem mode): vocals, drums, bass and other, each written to `dest` as a 16-bit WAV at the
model's rate (44.1 kHz) and the input's channel count (mono is separated as stereo and folded
back). `dest` is a temporary folder the Node side made; it moves the stems into --out.
"""

import os
import sys
import time

import numpy as np

from film_py import done, model, models_dir, offline, quiet, spec, threads
from film_py import audio

STEMS = ("vocals", "drums", "bass", "other")


def main(argv) -> int:
    job = spec(argv)
    info = audio.check(job["in"], "--in")
    model("htdemucs")
    started = time.monotonic()
    with quiet():
        offline(models_dir())
        import soundfile as sf  # noqa: PLC0415
        import torch  # noqa: PLC0415
        from demucs.apply import apply_model  # noqa: PLC0415
        from demucs.pretrained import get_model  # noqa: PLC0415

        separator = get_model("htdemucs")
        separator.eval()
        rate = separator.samplerate
        x = audio.read(job["in"], rate, mono=False)
        channels = x.shape[0]
        if channels == 1:
            x = np.vstack([x, x])
        elif channels > 2:
            x = x[:2]
        wav = torch.from_numpy(x.astype(np.float32))
        reference = wav.mean(0)
        centre, scale = reference.mean(), reference.std()
        if float(scale) == 0.0:
            scale = torch.tensor(1.0)
        with torch.inference_mode():
            sources = apply_model(separator, ((wav - centre) / scale)[None], device="cpu", shifts=0, split=True,
                                  overlap=0.25, progress=False, num_workers=0)[0]
        sources = sources * scale + centre
        written = {}
        clipped = {}
        for name in STEMS:
            y = sources[separator.sources.index(name)].numpy()
            if channels == 1:
                y = y.mean(axis=0, keepdims=True)
            clipped[name] = int(np.sum(np.abs(y) > 1.0))
            path = os.path.join(job["dest"], f"{name}.wav")
            sf.write(path, np.clip(y, -1.0, 1.0).T, rate, subtype="PCM_16")
            written[name] = f"{name}.wav"
    done({
        "stems": written,
        "model": {"name": "htdemucs", "source": "demucs.pretrained htdemucs", "device": "cpu", "threads": threads(), "shifts": 0, "overlap": 0.25},
        "sample_rate": rate,
        "channels": min(channels, 2) if channels > 1 else 1,
        "input_rate": info.samplerate,
        "duration": round(x.shape[1] / rate, 4),
        "clipped_samples": clipped,
        "seconds": round(time.monotonic() - started, 1),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
