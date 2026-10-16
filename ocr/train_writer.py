"""Teach the reading model one person's handwriting, from their corrected lines.

    python ocr/train_writer.py --models MODELS_DIR --examples lines.tsv --out writer.pt

lines.tsv has one line per row, tab-separated: image path, correct text, and
optionally what a reader first read and which reader it was ("gemini", ...).

Training always starts from the base model (never from an earlier personal
model, so errors cannot pile up). Some lines are held back to measure the result,
and the new model is kept only if it reads those lines better than the base
model does. Lines from the Pinkas corpus (real handwriting, CC-BY-4.0) are mixed
in so the model does not forget handwriting in general.

Progress is printed as JSON lines: {"step": n, "of": total}, then a final
{"done": true, "kept": bool, "before": cer, "after": cer, ...}.

The personal model carries the base model's licence (for Mishkefet-v1 that is
CC-BY-NC-SA-4.0, non-commercial; base.pt is commercial-safe).

When some held-back lines were first read by Gemini, the report also gives
Gemini's error rate on exactly those lines next to the personal model's, so the
app can switch a writer to the reader that is better for them.
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402  (also makes model loading tensors-only)
from hebocr.charset import Charset  # noqa: E402
from hebocr.data.hebrew_ink import load_hebrew_ink  # noqa: E402
from hebocr.data.synth import LineDataset, collate  # noqa: E402
from hebocr.data.transforms import preprocess  # noqa: E402
from hebocr.decode import greedy_decode  # noqa: E402
from hebocr.models.htr_vt import build_model  # noqa: E402
from rapidfuzz.distance import Levenshtein  # noqa: E402

TRAIN_TOP_LAYERS = 4      # of 8: the lower layers keep what they know about ink in general
LR = 3e-5
PIXEL_BUDGET = 14000      # lines x width of the widest, per step (memory and speed on a CPU)
REHEARSAL_SHARE = 0.25


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def load_rows(tsv: Path):
    rows = []
    for line in tsv.read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        cols = line.split("\t")
        path, text = cols[0], cols[1].strip() if len(cols) > 1 else ""
        if not Path(path).is_absolute():
            path = str(tsv.parent / path)  # exports list images next to lines.tsv
        if not text:
            continue
        try:
            image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        except Exception:
            continue
        rows.append({"image": image, "text": text,
                     "ai": cols[2] if len(cols) > 2 else None, "source": cols[3].strip() if len(cols) > 3 else None})
    return rows


@torch.no_grad()
def cer(model, charset, rows):
    """Character error rate (0 = perfect) over the rows, plain best-path reading."""
    model.eval()
    errors = chars = 0
    for row in rows:
        arr = torch.from_numpy(preprocess(row["image"]))[None]
        logprobs = model(arr.to(next(model.parameters()).device)).float().cpu()
        text = greedy_decode(logprobs, model.output_lengths(torch.tensor([arr.shape[-1]])), charset)[0]
        errors += Levenshtein.distance(text, row["text"])
        chars += max(1, len(row["text"]))
    model.train()
    if not next(model.cnn.parameters()).requires_grad:
        model.cnn.eval()
    return errors / max(1, chars)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", required=True)
    ap.add_argument("--examples", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=0, help="0 = choose from the number of lines")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--base", default="", help="start from this model instead of the server's base model")
    ap.add_argument("--top-layers", type=int, default=TRAIN_TOP_LAYERS,
                    help="how many of the 8 encoder layers to train (8 = all; use on a GPU)")
    ap.add_argument("--device", default="cpu", help="cpu, or cuda on a machine with a graphics card")
    ap.add_argument("--max-steps", type=int, default=300, help="cap on the chosen number of steps")
    ap.add_argument("--eval-only-source", default="",
                    help="lines first read by this reader (e.g. gemini) are only used to "
                         "measure, never trained on")
    args = ap.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    random.seed(args.seed)
    rng = np.random.default_rng(args.seed)
    models = Path(args.models)

    rows = load_rows(Path(args.examples))
    if len(rows) < 5:
        emit(done=True, kept=False, reason="too_few", lines=len(rows))
        return 0
    random.shuffle(rows)
    measure_only = [r for r in rows if args.eval_only_source and r["source"] == args.eval_only_source][:300]
    rows = [r for r in rows if not (args.eval_only_source and r["source"] == args.eval_only_source)]
    n_hold = max(5, len(rows) // 7) if len(rows) >= 20 else 0
    held, train_rows = rows[:n_hold] + measure_only, rows[n_hold:]
    if len(train_rows) < 5:
        emit(done=True, kept=False, reason="too_few", lines=len(train_rows))
        return 0

    state = torch.load(args.base or engine.base_model_path(models), map_location="cpu")
    device = torch.device(args.device)
    charset = Charset(chars=state["charset"])
    config = state.get("config", {})
    model = build_model(charset.n_classes, config.get("size", "large"), mask_ratio=0.0)
    model.load_state_dict(state["model"])
    for p in model.parameters():
        p.requires_grad = False
    for layer in list(model.encoder.layers)[-args.top_layers:]:
        for p in layer.parameters():
            p.requires_grad = True
    for p in list(model.norm.parameters()) + list(model.head.parameters()):
        p.requires_grad = True
    if args.top_layers >= len(model.encoder.layers):
        for p in model.parameters():
            p.requires_grad = True
    model.to(device)
    model.train()
    if args.top_layers < len(model.encoder.layers):
        model.cnn.eval()  # frozen: keep its normalization statistics fixed

    rehearsal = []
    if (models / "pinkas.zip").exists():
        rehearsal = load_hebrew_ink(("pinkas",), root=models, split="all")
    writer_ds = LineDataset(train_rows, charset, train=True, seed=args.seed)
    reh_ds = LineDataset(rehearsal, charset, train=True, seed=args.seed + 1) if rehearsal else None

    steps = args.steps or int(min(args.max_steps, max(80, 3 * len(train_rows))))
    eval_every = max(20, steps // 5)
    before = cer(model, charset, held) if held else None
    emit(step=0, of=steps, before=before, lines=len(train_rows), held=len(held))

    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=LR, weight_decay=0.01)
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)

    def take(ds, count):
        picked, widest = [], 0
        for i in rng.integers(len(ds), size=count * 3):
            item = ds[int(i)]
            nxt = max(widest, item[0].shape[-1])
            if picked and (len(picked) + 1) * nxt > PIXEL_BUDGET:
                continue
            picked.append(item)
            widest = nxt
            if len(picked) >= count:
                break
        return picked

    best_cer, best_state, best_step = before, None, 0
    started = time.time()
    for step in range(1, steps + 1):
        n_reh = 2 if reh_ds else 0
        picks = take(writer_ds, 8 - n_reh) + (take(reh_ds, n_reh) if reh_ds else [])
        batch = collate(picks)
        logprobs = model(batch.images.to(device))
        loss = ctc(logprobs.float().permute(1, 0, 2), batch.targets.to(device),
                   model.output_lengths(batch.widths).to(device), batch.target_lengths.to(device))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

        if step % eval_every == 0 or step == steps:
            score = cer(model, charset, held) if held else None
            if not held or score < best_cer:
                best_cer, best_step = score, step
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            emit(step=step, of=steps, cer=score, loss=round(float(loss.detach()), 4),
                 seconds=round(time.time() - started))
        elif step % 5 == 0:
            emit(step=step, of=steps)

    # Head to head with Gemini, on the held-back lines Gemini first read.
    vs = [r for r in held if r["source"] == "gemini" and r["ai"] is not None]
    gemini = personal_on_gemini = None
    if len(vs) >= 5:
        gemini = sum(Levenshtein.distance(r["ai"], r["text"]) for r in vs) / max(1, sum(len(r["text"]) for r in vs))
        if best_state is not None:
            model.load_state_dict(best_state)
        personal_on_gemini = cer(model, charset, vs)

    kept = best_state is not None
    if kept:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".part")
        torch.save({"model": best_state, "charset": charset.chars, "config": config, "step": best_step}, tmp)
        tmp.rename(out)
    emit(done=True, kept=kept, before=before, after=best_cer, step=best_step,
         lines=len(train_rows), held=len(held), seconds=round(time.time() - started),
         gemini=gemini, personal_on_gemini=personal_on_gemini, compared=len(vs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
