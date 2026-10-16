"""Get everything the free reading engine needs except its base model.

    python ocr/fetch_models.py [MODELS_DIR] [--noncommercial]     (default: ./models)

Downloads come from fixed versions and must match their SHA-256 fingerprints, so
a changed or tampered file is refused rather than loaded.

- The Pinkas dataset (https://zenodo.org/records/3569694), CC-BY-4.0: real
  handwritten Hebrew lines mixed into personal training so a writer's model
  doesn't forget other handwriting.
- Hebrew letter and word statistics, built from Hebrew Wikipedia (CC-BY-SA) by
  build_stats.py.
- The base model is base.pt, trained with ocr/train_base.ipynb on data that
  allows commercial use. Copy it into MODELS_DIR yourself.
- With --noncommercial, also Mishkefet-v1 (https://huggingface.co/itayinbar/Mishkefet-v1),
  more accurate today but CC-BY-NC-SA-4.0: not for an app you charge for.
  Use it with OCR_ALLOW_NONCOMMERCIAL=1.
"""

import hashlib
import subprocess
import sys
import urllib.request
from pathlib import Path

MODEL_REV = "23b3e237ffbf8ef73e87ef7c64dcf080e41e416b"
HF = f"https://huggingface.co/itayinbar/Mishkefet-v1/resolve/{MODEL_REV}"

NONCOMMERCIAL = {
    "mishkefet-v1.pt": (f"{HF}/mishkefet-v1.pt", "0dfb82e440ebfa9dd61f562ad36a83ec41c23904eacd96623c3bd8f6fd850b88"),
}

FILES = {
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = Path(args[0] if args else "models")
    root.mkdir(parents=True, exist_ok=True)
    files = dict(FILES)
    if "--noncommercial" in sys.argv:
        files.update(NONCOMMERCIAL)
    for name, (url, digest) in files.items():
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
    subprocess.run([sys.executable, str(Path(__file__).with_name("build_stats.py")), str(root)], check=True)
    if not (root / "base.pt").exists():
        print(f"\nStill needed: {root}/base.pt, the base model from ocr/train_base.ipynb (see README).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
