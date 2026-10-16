import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// The reading engine runs as a Python process (ocr/worker.py) that stays
// loaded; personal training runs as a separate process per job.

const here = path.dirname(fileURLToPath(import.meta.url));
const OCR_DIR = path.join(here, "..", "ocr");
const localVenv = path.join(here, "..", ".venv", "bin", "python");
const PYTHON = process.env.OCR_PYTHON || (fs.existsSync(localVenv) ? localVenv : "python3");
export const MODELS_DIR = path.resolve(process.env.OCR_MODELS_DIR || path.join(here, "..", "models"));
const THREADS = process.env.OCR_THREADS || "";

/** Whether the free engine has a base model to read with (the same rule as ocr/engine.py). */
export function localModelAvailable() {
  if (process.env.OCR_BASE_MODEL) return fs.existsSync(path.resolve(MODELS_DIR, process.env.OCR_BASE_MODEL));
  if (fs.existsSync(path.join(MODELS_DIR, "base.pt"))) return true;
  return process.env.OCR_ALLOW_NONCOMMERCIAL === "1" && fs.existsSync(path.join(MODELS_DIR, "mishkefet-v1.pt"));
}

const env = () => ({ ...process.env, OCR_MODELS_DIR: MODELS_DIR, OCR_THREADS: THREADS, PYTHONUNBUFFERED: "1" });

export class OcrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let worker = null; // { proc, ready: Promise, pending: Map }
let nextId = 1;

function startWorker() {
  const proc = spawn(PYTHON, [path.join(OCR_DIR, "worker.py")], { env: env(), stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let markReady, markFailed;
  const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
  ready.catch(() => {});

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if ("ready" in msg) {
      if (msg.ready) markReady();
      else markFailed(new OcrError(msg.code || "engine_failed", msg.error || "The reading engine did not start."));
      return;
    }
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.progress) return job.onProgress?.(msg.progress.step, msg.progress.of);
    pending.delete(msg.id);
    if (msg.ok) job.resolve(msg);
    else job.reject(new OcrError(msg.code || "read_failed", msg.error || "Reading failed."));
  });

  const fail = (error) => {
    markFailed(error);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    if (worker?.proc === proc) worker = null;
  };
  proc.on("error", (error) =>
    fail(new OcrError("engine_missing", `Could not start the reading engine (${PYTHON}): ${error.message}`))
  );
  proc.on("exit", (code) => fail(new OcrError("engine_failed", `The reading engine stopped (exit code ${code}).`)));
  return { proc, ready, pending };
}

async function call(cmd, payload, onProgress) {
  if (!worker) worker = startWorker();
  const w = worker;
  await w.ready;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    w.pending.set(id, { resolve, reject, onProgress });
    w.proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + "\n");
  });
}

// The engine reads one page at a time (it already uses every CPU core).
let chain = Promise.resolve();

/** Read a page image. Resolves with lines: {text, top, bottom, left, right, unclear}. */
export function readPage(imagePath, { model = null, fixes = [], onProgress } = {}) {
  const run = chain.then(() => call("read", { image: imagePath, model, fixes }, onProgress));
  chain = run.catch(() => {});
  return run.then((msg) => msg.lines);
}

/** Start the engine early so the first page doesn't wait for it. */
export function warmUp() {
  call("ping", {}).catch((error) => console.error("Reading engine:", error.message));
}

/**
 * Train a personal model. `examplesTsv` lists image paths and correct texts.
 * Resolves with the final report: {kept, before, after, lines, held, seconds}.
 */
export function trainWriter(examplesTsv, outPath, evalOnlySource, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [path.join(OCR_DIR, "train_writer.py"), "--models", MODELS_DIR, "--examples", examplesTsv, "--out", outPath];
    if (evalOnlySource) args.push("--eval-only-source", evalOnlySource);
    if (THREADS) args.push("--threads", THREADS);
    const proc = spawn(PYTHON, args, { env: env(), stdio: ["ignore", "pipe", "inherit"] });
    let report = null;
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.done) report = msg;
      else if (msg.step != null) onProgress?.(msg.step, msg.of, msg);
    });
    proc.on("error", (error) => reject(new OcrError("engine_missing", error.message)));
    proc.on("exit", (code) => {
      if (report) resolve(report);
      else reject(new OcrError("train_failed", `Training stopped (exit code ${code}).`));
    });
  });
}
