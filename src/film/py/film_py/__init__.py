"""The film engine's Python side.

Each module is run by the kit's Node commands as `python3 -I -m film_py.<module>`, with the
kit's own `src/film/py` folder first on the path. The protocol, shared by every module:

- exit 0: the result is one JSON document on stdout;
- exit 2: refused before any work, one line per problem on stdout;
- anything else: unexpected; the Node side prints one short line of its own.

This file imports nothing heavy: `film:score` loads it without torch.
"""

import contextlib
import json
import logging
import os
import sys
import warnings
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
        # ok: downloaded by this run of models.py; present: found already in place by a later run.
        if entry.get("status") not in ("ok", "present"):
            raise KeyError(key)
        path = root / entry["path"]
        if not path.exists():
            raise FileNotFoundError(path)
    except (OSError, ValueError, KeyError, TypeError):
        # The folder comes from FILM_MODELS: printed JSON-quoted, so it stays on one line.
        where = shown(str(root))
        refuse([f"model {key} is not in {where} (run python3 -I src/film/py/film_py/models.py --dest {where})"])
    return path


def spec(argv) -> dict:
    """The JSON spec a listening module works from: its one argument.

    The kit's runner always passes the spec as the argument (it gives the child no stdin); stdin
    is read only when there is no argument, for running a module by hand.
    """
    try:
        text = argv[0] if argv else sys.stdin.read()
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError("not an object")
    except (ValueError, IndexError):
        refuse(["the spec is not a JSON object"])
    return value


@contextlib.contextmanager
def quiet():
    """Keeps the libraries' chatter off stdout while the work runs, so stdout holds only the result.

    Python's own prints and anything a C library writes to file descriptor 1 go to stderr; the
    libraries' loggers and warnings are silenced. stdout is put back when the block ends.
    """
    logging.disable(logging.WARNING)
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        with warnings.catch_warnings(), contextlib.redirect_stdout(sys.stderr):
            warnings.simplefilter("ignore")
            yield
    finally:
        sys.stderr.flush()
        os.dup2(saved, 1)
        os.close(saved)
        logging.disable(logging.NOTSET)


def threads() -> int:
    """The CPUs this process may use: the cgroup's quota when one is set, else the affinity mask."""
    try:
        count = len(os.sched_getaffinity(0))
    except AttributeError:
        count = os.cpu_count() or 1
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text(encoding="ascii").split()[:2]
        if quota != "max":
            count = min(count, max(1, int(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, count)


def offline(root: Path) -> None:
    """Points torch hub and the Hugging Face cache at the downloaded models and forbids downloads."""
    os.environ["HF_HOME"] = str(root / "hf")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TORCH_HOME"] = str(root / "torch")
    import torch  # noqa: PLC0415  (heavy; only the commands that need it pay for it)

    torch.hub.set_dir(str(root / "torch" / "hub"))
    torch.set_num_threads(threads())
