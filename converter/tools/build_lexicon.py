"""Build the converter's word list from Sefaria's Hebrew library and embed it.

    python3 converter/tools/build_lexicon.py WORK_DIR

Downloads the Hebrew text of every book in Sefaria's public export (about
2.6 GB, from https://github.com/Sefaria/Sefaria-Export and its storage bucket),
counts every word (niqqud and cantillation removed, ״ ׳ as " '), adds common
modern Hebrew words from the wordfreq list, drops likely typos in the sources
(a rare word with a far more common word one letter away), and writes the list
into converter/hebrew-converter.html as a gzip+base64 block, most common first.

Sefaria's texts carry their own licences (many CC-BY or public domain, some
CC-BY-NC); the converter holds only a word list, not the texts.
"""

import base64, collections, concurrent.futures, gzip, json, re, sys, urllib.request
from pathlib import Path

BOOKS = "https://raw.githubusercontent.com/Sefaria/Sefaria-Export/master/books.json"
HTML = Path(__file__).resolve().parent.parent / "hebrew-converter.html"
TAG = re.compile(r"<[^>]+>")
MARKS = re.compile(r"[֑-ׇ]")
WORD = re.compile(r"[א-ת]+(?:[\"'׳״][א-ת]+)*[\"'׳״]?")
OK = re.compile(r'^[א-ת]+(?:["\'][א-ת]+)*["\']?$')
HEB = "אבגדהוזחטיכלמנסעפצקרשתךםןףץ"


def download(work: Path) -> Path:
    txt = work / "txt"
    txt.mkdir(parents=True, exist_ok=True)
    books = json.load(urllib.request.urlopen(BOOKS))["books"]
    urls = [b["txt_url"] for b in books if b["language"] == "Hebrew" and b["versionTitle"] == "merged" and b.get("txt_url")]

    def get(item):
        i, url = item
        path = txt / f"{i:05d}.txt"
        if not path.exists():
            urllib.request.urlretrieve(url, path)

    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        list(pool.map(get, enumerate(urls)))
    print(f"{len(urls)} Hebrew books downloaded", flush=True)
    return txt


def count(txt: Path) -> collections.Counter:
    counts = collections.Counter()
    for path in txt.glob("*.txt"):
        body = "\n".join(path.read_text(encoding="utf-8", errors="ignore").split("\n")[8:])  # skip the header
        body = MARKS.sub("", TAG.sub(" ", body).replace("־", " ").replace("׃", " "))
        for w in WORD.findall(body.replace("״", '"').replace("׳", "'")):
            counts[w] += 1
    return counts


def neighbours(w):
    for i in range(len(w) + 1):
        if i < len(w):
            yield w[:i] + w[i + 1:]
            for ch in HEB:
                yield w[:i] + ch + w[i + 1:]
        if i < len(w) - 1:
            yield w[:i] + w[i + 1] + w[i] + w[i + 2:]
        for ch in HEB:
            yield w[:i] + ch + w[i:]


def main() -> int:
    work = Path(sys.argv[1] if len(sys.argv) > 1 else "sefaria-work")
    counts = count(download(work))
    print(f"{sum(counts.values())} words, {len(counts)} different", flush=True)
    total = {w: c for w, c in counts.items() if c >= 3 and OK.match(w)}
    from wordfreq import top_n_list, word_frequency  # modern Hebrew (data CC-BY-SA)
    for w in top_n_list("he", 200_000):
        w = w.replace("״", '"').replace("׳", "'")
        if OK.match(w):
            total[w] = total.get(w, 0) + int(word_frequency(w, "he") * 1e8)
    typos = {w for w, c in total.items() if c <= 10 and len(w) >= 4
             and any(total.get(n, 0) >= 1000 * c for n in neighbours(w) if n != w)}
    for w in typos:
        del total[w]
    words = [w for w, _ in sorted(total.items(), key=lambda kv: -kv[1])]
    b64 = base64.b64encode(gzip.compress("\n".join(words).encode(), 9)).decode()
    html = HTML.read_text(encoding="utf-8")
    html, n = re.subn(r'(<script type="application/octet-stream" id="lexicon">)[^<]*(</script>)',
                      lambda m: m.group(1) + b64 + m.group(2), html)
    assert n == 1, "lexicon block not found"
    HTML.write_text(html, encoding="utf-8")
    print(f"{len(words)} words ({len(typos)} likely typos dropped) written into {HTML.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
