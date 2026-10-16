"""Download the reading model and the rehearsal data, and check them.

    python ocr/fetch_models.py [MODELS_DIR]        (default: ./models)

Files come from fixed versions and must match their SHA-256 fingerprints, so a
changed or tampered file is refused rather than loaded.

- Mishkefet-v1 (https://huggingface.co/itayinbar/Mishkefet-v1): the recognizer
  weights and its two language models. CC-BY-NC-SA-4.0: non-commercial use only.
- The Pinkas dataset (https://zenodo.org/records/3569694), CC-BY-4.0: real
  handwritten Hebrew lines mixed into personal training so a writer's model
  doesn't forget other handwriting.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

MODEL_REV = "23b3e237ffbf8ef73e87ef7c64dcf080e41e416b"
HF = f"https://huggingface.co/itayinbar/Mishkefet-v1/resolve/{MODEL_REV}"

FILES = {
    "mishkefet-v1.pt": (f"{HF}/mishkefet-v1.pt", "0dfb82e440ebfa9dd61f562ad36a83ec41c23904eacd96623c3bd8f6fd850b88"),
    "hebrew_char6.pkl": (f"{HF}/hebrew_char6.pkl", "60e6b974e797c74e2c543b27bfe1f9b02e8e8960594cfde7dc452553e4be2161"),
    "hebrew_words.pkl": (f"{HF}/hebrew_words.pkl", "39f8ed30114125d53a47d4c383e48338bd5f8ffce21ae981e5fd7f99ade08874"),
    "pinkas.zip": (
        "https://zenodo.org/api/records/3569694/files/pinkas_dataset.zip/content",
        "40857c02c106dcd0e7d7467977c44373dad77a8b680557fbd6f3e560cc42ee6d",
    ),
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
    root.mkdir(parents=True, exist_ok=True)
    for name, (url, digest) in FILES.items():
        target = root / name
        if target.exists() and sha256(target) == digest:
            print(f"ok       {name}")
            continue
        print(f"fetching {name} ...", flush=True)
        tmp = target.with_suffix(target.suffix + ".part")
        urllib.request.urlretrieve(url, tmp)
        got = sha256(tmp)
        if got != digest:
            tmp.unlink()
            print(f"REFUSED  {name}: fingerprint {got} does not match {digest}", file=sys.stderr)
            return 1
        tmp.rename(target)
        print(f"ok       {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
