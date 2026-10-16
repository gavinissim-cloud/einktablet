"""Build the Hebrew letter and word statistics the reader uses, from Hebrew Wikipedia.

    python ocr/build_stats.py MODELS_DIR

Writes hebrew_char6.pkl (a character 6-gram model) and hebrew_words.pkl (word
frequencies), from Hebrew Wikipedia (CC-BY-SA, which allows commercial use; takes
a few minutes and streams about 150 MB of text), and gershayim.json, from the
wordfreq word list (code Apache-2.0, data CC-BY-SA): abbreviations such as ד"ר
next to the "two yods" spelling the reader may see instead (דייר), kept where the
abbreviation is the more common word.

Adapted from heb-ocr's scripts/build_lm.py and scripts/build_wordlm.py
(MIT, Copyright (c) 2026 Itay Inbar), with the same settings.
"""

import re
import sys
from pathlib import Path

from hebocr.lm import CharNGramLM
from hebocr.wordlm import WordUnigramLM

WIKIPEDIA = ("wikimedia/wikipedia", "20231101.he")
SENTENCE_SPLIT = re.compile(r"[\n.!?;]+")
# Keep Hebrew, digits and the punctuation the reader can write; drop markup and other scripts.
KEEP = re.compile(r"[^֐-׿0-9 '\"\-.,:;!?()\[\]/]+")


def _clean(chunk: str) -> str | None:
    cleaned = re.sub(r"\s+", " ", KEEP.sub(" ", chunk)).strip()
    if len(cleaned) < 12:
        return None
    hebrew = sum("֐" <= c <= "׿" for c in cleaned)
    return cleaned if hebrew >= len(cleaned) * 0.5 else None


def wikipedia_lines(max_chars: int):
    from datasets import load_dataset

    seen = 0
    for article in load_dataset(*WIKIPEDIA, split="train", streaming=True):
        for chunk in SENTENCE_SPLIT.split(article["text"]):
            cleaned = _clean(chunk)
            if cleaned:
                yield cleaned
                seen += len(cleaned)
                if seen >= max_chars:
                    return


def build_gershayim(path: Path) -> None:
    import json
    from wordfreq import top_n_list, zipf_frequency

    table = {}
    for word in top_n_list("he", 300_000):
        if word.count('"') != 1 or not re.fullmatch(r'[\u05d0-\u05ea]+"[\u05d0-\u05ea]+', word):
            continue
        yods = word.replace('"', "יי")
        if zipf_frequency(word, "he") >= zipf_frequency(yods, "he"):
            table.setdefault(yods, word)
    path.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
    print(f"gershayim table: {len(table)} abbreviations", flush=True)


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
    out.mkdir(parents=True, exist_ok=True)
    if not (out / "hebrew_char6.pkl").exists():
        print("building letter statistics (30M characters)...", flush=True)
        lm = CharNGramLM(order=6)
        lm.train(wikipedia_lines(30_000_000), progress_every=200_000)
        lm.prune(min_count=3)
        lm.save(out / "hebrew_char6.pkl")
    if not (out / "hebrew_words.pkl").exists():
        print("building word statistics (120M characters)...", flush=True)
        wlm = WordUnigramLM()
        wlm.train(wikipedia_lines(120_000_000), progress_every=500_000)
        wlm.prune(min_count=2)
        wlm.save(out / "hebrew_words.pkl")
    if not (out / "gershayim.json").exists():
        build_gershayim(out / "gershayim.json")
    print("statistics ready", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
