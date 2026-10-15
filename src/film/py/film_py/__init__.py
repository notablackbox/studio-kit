"""The film engine's Python side.

Each module is run by the kit's Node commands as `python3 -I -m film_py.<module>`, with the
kit's own `src/film/py` folder first on the path. The protocol, shared by every module:

- exit 0: the result is one JSON document on stdout;
- exit 2: refused before any work, one line per problem on stdout;
- anything else: unexpected; the Node side prints one short line of its own.

This file imports nothing heavy: `film:score` loads it without torch.
"""

import json
import os
import sys
from pathlib import Path
from typing import NoReturn

DEFAULT_MODELS = "/opt/models"
MANIFEST = "models.json"


def models_dir() -> Path:
    """The folder the model weights were downloaded into at image build."""
    return Path(os.environ.get("FILM_MODELS") or DEFAULT_MODELS)


def shown(value) -> str:
    """An untrusted value as it appears in a printed line: JSON-quoted, controls escaped.

    The same rule as the kit's `shown()` in `src/film/lib/cli.ts`.
    """
    text = json.dumps(value, ensure_ascii=False)
    return "".join(
        f"\\u{ord(c):04x}" if 0x7F <= ord(c) <= 0x9F or c in "\u2028\u2029" else c for c in text
    )


def refuse(lines) -> NoReturn:
    """Refused before any work: one line per problem on stdout, exit 2."""
    for line in lines:
        print(line)
    sys.stdout.flush()
    sys.exit(2)


def done(result) -> None:
    """The result, as one JSON document on stdout."""
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def model(key: str) -> Path:
    """The folder of a downloaded model, or a refusal naming it when it is absent."""
    root = models_dir()
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
        entry = manifest["models"][key]
        if entry.get("status") != "ok":
            raise KeyError(key)
        path = root / entry["path"]
        if not path.exists():
            raise FileNotFoundError(path)
    except (OSError, ValueError, KeyError, TypeError):
        # The folder comes from FILM_MODELS: printed JSON-quoted, so it stays on one line.
        where = shown(str(root))
        refuse([f"model {key} is not in {where} (run python3 -I src/film/py/film_py/models.py --dest {where})"])
    return path


def offline(root: Path) -> None:
    """Points torch hub and the Hugging Face cache at the downloaded models and forbids downloads."""
    os.environ["HF_HOME"] = str(root / "hf")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TORCH_HOME"] = str(root / "torch")
    import torch  # noqa: PLC0415  (heavy; only the commands that need it pay for it)

    torch.hub.set_dir(str(root / "torch" / "hub"))
