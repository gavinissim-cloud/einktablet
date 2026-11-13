"""Make the Hebrew + English converter from the Hebrew one.

    pip install wordfreq
    python3 converter/tools/build_mixed.py

converter/hebrew-converter.html is the source. This writes
converter/hebrew-english-converter.html: the same file with MIXED switched on, its own title,
and an English word list (the 100,000 most common English words, from wordfreq) added next to
the Hebrew one. Run it again after every change to hebrew-converter.html.

The two files are fully separate when used: each keeps its own documents, people, corrections,
settings and Gemini key, and a backup of one can't be restored into the other.
"""

import base64, gzip, re
from pathlib import Path

from wordfreq import top_n_list

HERE = Path(__file__).resolve().parent.parent
SRC = HERE / "hebrew-converter.html"
OUT = HERE / "hebrew-english-converter.html"
WORD = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")


def english_words(n: int = 100_000) -> list[str]:
    out, seen = [], set()
    for w in top_n_list("en", n * 2):
        w = w.lower().replace("’", "'")
        if WORD.match(w) and w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= n:
            break
    return out


def main() -> None:
    html = SRC.read_text(encoding="utf-8")

    def swap(old: str, new: str) -> None:
        nonlocal html
        if html.count(old) != 1:
            raise SystemExit(f"expected exactly one {old!r} in {SRC.name}")
        html = html.replace(old, new)

    swap("const MIXED = false;", "const MIXED = true;")
    swap("<title>Hebrew Handwriting Converter</title>", "<title>Hebrew + English Handwriting Converter</title>")
    swap("<h1>Hebrew Handwriting Converter</h1>", "<h1>Hebrew + English Handwriting Converter</h1>")
    words = english_words()
    data = base64.b64encode(gzip.compress("\n".join(words).encode("utf-8"), 9, mtime=0)).decode("ascii")
    swap('<script type="application/octet-stream" id="lexicon">',
         f'<script type="application/octet-stream" id="lexicon-en">{data}</script>\n<script type="application/octet-stream" id="lexicon">')
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(words)} English words)")


if __name__ == "__main__":
    main()
