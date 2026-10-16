"""Reading pages of Hebrew handwriting with Mishkefet (heb-ocr), on the CPU.

Everything runs locally: no network and no paid service. The model files come
from fetch_models.py and are loaded in a mode that refuses to run code, so a
tampered download cannot execute anything.
"""

import math
import pickle
import types
from pathlib import Path

import torch
from PIL import Image, ImageOps

# ---------- Load model files without letting them run code ----------

_torch_load = torch.load


def _tensors_only_load(*args, **kwargs):
    kwargs["weights_only"] = True  # only tensors and plain data, never objects
    return _torch_load(*args, **kwargs)


torch.load = _tensors_only_load


class _DataOnlyUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"refusing to load {module}.{name} from a model file")


_data_only_pickle = types.SimpleNamespace(
    load=lambda fh: _DataOnlyUnpickler(fh).load(),
    dump=pickle.dump,
    HIGHEST_PROTOCOL=pickle.HIGHEST_PROTOCOL,
)

import hebocr.lm  # noqa: E402
import hebocr.wordlm  # noqa: E402

hebocr.lm.pickle = _data_only_pickle
hebocr.wordlm.pickle = _data_only_pickle

from hebocr.data.transforms import preprocess  # noqa: E402
from hebocr.decode import beam_decode, greedy_confidence, greedy_decode  # noqa: E402
from hebocr.lm import CharNGramLM  # noqa: E402
from hebocr.page.segment import segment_page  # noqa: E402
from hebocr.recognize import Recognizer  # noqa: E402
from hebocr.wordlm import WordUnigramLM  # noqa: E402

# The settings that scored best for whole pages on the ivrit.ai benchmark.
BEAM_WIDTH = 12
LM_WEIGHT = 0.4
WORD_WEIGHT = 0.2

PUNCT = "\"'״׳.,:;!?()[]–-־"


def _strip(word: str) -> str:
    return word.strip(PUNCT)


class Engine:
    def __init__(self, models_dir: str | Path, threads: int | None = None):
        self.dir = Path(models_dir)
        if threads:
            torch.set_num_threads(threads)
        self.char_lm = CharNGramLM.load(self.dir / "hebrew_char6.pkl")
        self.word_lm = WordUnigramLM.load(self.dir / "hebrew_words.pkl")
        self.base_path = self.dir / "mishkefet-v1.pt"
        self._models: dict[str, Recognizer] = {}

    def recognizer(self, checkpoint: str | Path | None = None) -> Recognizer:
        """The base model, or a writer's personal model. Keeps the last two loaded."""
        path = str(checkpoint or self.base_path)
        if path not in self._models:
            if len(self._models) >= 2:
                self._models.pop(next(k for k in self._models if k != str(self.base_path)))
            self._models[path] = Recognizer(
                path, device="cpu", lm=self.char_lm, lm_weight=LM_WEIGHT, beam_width=BEAM_WIDTH,
                word_lm=self.word_lm, word_weight=WORD_WEIGHT,
            )
        return self._models[path]

    @torch.no_grad()
    def read_lines(self, rec: Recognizer, crops: list[Image.Image], batch_size: int = 8):
        """Read line crops. Returns (text, confidence, greedy_text) per crop.

        The careful (beam + language model) reading is what we keep; the plain
        best-path reading is used only to spot words the two disagree on.
        """
        out = [None] * len(crops)
        order = sorted(range(len(crops)), key=lambda i: crops[i].width / max(crops[i].height, 1))
        for start in range(0, len(order), batch_size):
            chunk = order[start:start + batch_size]
            arrays = [torch.from_numpy(preprocess(crops[i])) for i in chunk]
            widths = torch.tensor([a.shape[-1] for a in arrays], dtype=torch.long)
            batch = torch.zeros(len(arrays), 1, arrays[0].shape[-2], int(widths.max()))
            for j, a in enumerate(arrays):
                batch[j, :, :, : a.shape[-1]] = a
            logprobs = rec.model(batch).float()
            lengths = rec.model.output_lengths(widths)
            careful = beam_decode(
                logprobs, lengths, rec.charset, beam_width=BEAM_WIDTH, lm=self.char_lm,
                lm_weight=LM_WEIGHT, length_bonus=rec.length_bonus,
                word_lm=self.word_lm, word_weight=WORD_WEIGHT,
            )
            plain = greedy_decode(logprobs, lengths, rec.charset)
            confs = greedy_confidence(logprobs, lengths)
            for j, i in enumerate(chunk):
                out[i] = (careful[j], confs[j], plain[j])
        return out

    def unclear_words(self, text: str, plain: str) -> list[str]:
        """Words worth a second look: unknown to the dictionary, or read
        differently by the careful and the plain reading."""
        plain_words = set(plain.split())
        unclear = []
        for word in text.split():
            core = _strip(word)
            if not core or core.isdigit():
                continue
            if word not in plain_words or not self.word_lm.known(core):
                unclear.append(word)
        return unclear

    def apply_fixes(self, text: str, fixes: dict[str, tuple[str, int]]) -> str:
        """Correct words this writer's earlier pages were misread as.

        A misreading that is itself a real word is only replaced once it has
        been corrected at least twice, so a one-off fix never rewrites good text.
        """
        if not fixes:
            return text
        words = text.split(" ")
        for i, word in enumerate(words):
            core = _strip(word)
            if core in fixes:
                to, count = fixes[core]
                if count >= 2 or not self.word_lm.known(core):
                    words[i] = word.replace(core, to, 1)
        return " ".join(words)

    def read_page(self, image_path: str | Path, checkpoint=None, fixes=None, progress=lambda step, of: None):
        """Find the lines on a page and read them.

        Returns lines with boxes in 0–1000 page coordinates (top, bottom, left,
        right), the reading, and the words to check.
        """
        image = ImageOps.exif_transpose(Image.open(image_path)).convert("RGB")
        progress(1, 2)
        crops, boxes, angle = segment_page(image)
        if not crops:
            return []
        progress(2, 2)
        rec = self.recognizer(checkpoint)
        results = self.read_lines(rec, crops)
        heights = sorted(b.h for b in boxes)
        typical = heights[len(heights) // 2] if heights else 1
        fixes = {f["from"]: (f["to"], int(f.get("count", 1))) for f in (fixes or []) if f.get("from") and " " not in f["from"]}

        lines = []
        for box, (text, conf, plain) in zip(boxes, results):
            text = text.strip()
            # Specks and margin marks: tiny, short and unsure.
            if not text or (len(_strip(text)) <= 2 and (conf < 0.8 or box.w < 2 * typical)):
                continue
            text = self.apply_fixes(text, fixes)
            lines.append({
                "text": text,
                **page_box(box, angle, image.width, image.height),
                "unclear": self.unclear_words(text, plain),
                "confidence": round(float(conf), 3),
            })
        return lines


def page_box(box, angle: float, width: int, height: int) -> dict:
    """A line box found on the straightened page, as 0–1000 coordinates of the
    original page: the upright rectangle around the box turned back."""
    cx, cy = width / 2, height / 2
    a = math.radians(angle)
    cos, sin = math.cos(a), math.sin(a)
    xs, ys = [], []
    for x, y in ((box.x, box.y), (box.x + box.w, box.y), (box.x, box.y + box.h), (box.x + box.w, box.y + box.h)):
        # PIL rotated the page counter-clockwise by `angle`; turn the point back.
        dx, dy = x - cx, y - cy
        xs.append(cx + dx * cos - dy * sin)
        ys.append(cy + dx * sin + dy * cos)
    clamp = lambda v, n: int(round(min(1000, max(0, v / n * 1000))))
    return {
        "top": clamp(min(ys), height),
        "bottom": clamp(max(ys), height),
        "left": clamp(min(xs), width),
        "right": clamp(max(xs), width),
    }


