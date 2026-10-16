"""Long-running reader the Node server talks to over stdin/stdout.

Requests, one JSON object per line:
    {"id": 1, "cmd": "read", "image": "/path/page.jpg", "model": "/path/writer.pt" | null,
     "fixes": [{"from": "...", "to": "...", "count": 2}, ...]}
    {"id": 2, "cmd": "ping"}
Answers, one JSON object per line:
    {"id": 1, "progress": {"step": 1, "of": 2}}
    {"id": 1, "ok": true, "lines": [{"text", "top", "bottom", "left", "right", "unclear", "confidence"}]}
    {"id": 1, "ok": false, "error": "...", "code": "..."}

The model stays loaded between pages, so only the first page pays for loading.
"""

import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    models = os.environ.get("OCR_MODELS_DIR", str(Path(__file__).resolve().parent.parent / "models"))
    threads = int(os.environ.get("OCR_THREADS") or 0) or None
    try:
        import engine

        eng = engine.Engine(models, threads=threads)
    except FileNotFoundError as error:
        send({"ready": False, "code": "models_missing", "error": f"Model files are missing in {models}: {error.filename}"})
        return 1
    send({"ready": True})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            if req.get("cmd") == "ping":
                send({"id": rid, "ok": True})
            elif req.get("cmd") == "read":
                model = req.get("model")
                if model and not Path(model).exists():
                    model = None
                lines = eng.read_page(
                    req["image"], checkpoint=model, fixes=req.get("fixes") or [],
                    progress=lambda step, of: send({"id": rid, "progress": {"step": step, "of": of}}),
                )
                send({"id": rid, "ok": True, "lines": lines})
            else:
                send({"id": rid, "ok": False, "code": "bad_request", "error": "unknown command"})
        except Exception as error:  # report and keep serving
            traceback.print_exc(file=sys.stderr)
            send({"id": rid, "ok": False, "code": "read_failed", "error": str(error)[:500]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
