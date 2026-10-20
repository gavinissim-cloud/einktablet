import * as store from "./store.js";
import { learningFor } from "./learning.js";
import { readPage, OcrError, localModelAvailable } from "./ocr.js";
import { readPageGemini, geminiEnabled } from "./gemini.js";
import { demoPage } from "./demo.js";

// Pages are read on the server, one after another, so reading continues even
// if the person closes the browser. Progress is written into the document.
// (The engine itself reads one page at a time using every CPU core.)

// Gemini pages are read in parallel (the free engine still reads one at a time).
const CONCURRENCY = Math.max(1, Number(process.env.READ_CONCURRENCY || 3));
const DEMO = process.env.DEMO_MODE === "1";
// Which reader reads pages: "auto" (Gemini when a key is set, a writer's own
// model once it reads them better), "gemini" or "local" (always the free engine).
const READER = process.env.READER || "auto";
const localAvailable = localModelAvailable;
const TRANSIENT = new Set(["rate_limited", "api_error"]);

/** Read with the right engine for this writer. Returns {lines, source}. */
async function readWithBestEngine(userId, writerId, imagePath, image, progress, onDraft) {
  const wantGemini = READER !== "local" && geminiEnabled();
  const learning = await learningFor(userId, writerId, { exampleImages: wantGemini ? 24 : 0 });
  const local = async () => {
    const lines = await readPage(imagePath, { model: learning.model, fixes: learning.fixes, onProgress: progress });
    return { lines, source: learning.model ? "personal" : "local" };
  };
  if (!wantGemini || (READER === "auto" && learning.beatsGemini)) return local();
  try {
    return { lines: await readPageGemini(image, { learning, onProgress: progress, onDraft }), source: "gemini" };
  } catch (error) {
    // Gemini busy or down: fall back to the free engine rather than fail the page.
    if (TRANSIENT.has(error.code) && localAvailable()) return local();
    throw error;
  }
}

const queue = [];
const queuedKeys = new Set();
let running = 0;
const key = (j) => `${j.userId}/${j.docId}/${j.pageId}`;

/** Ask for a page to be read (again). */
export async function requestReading(userId, docId, pageId) {
  const doc = await store.updatePage(userId, docId, pageId, { status: "queued", progress: null, draft: null, error: null, errorCode: null });
  if (!doc?.pages.some((p) => p.id === pageId)) return false;
  enqueue({ userId, docId, pageId });
  return true;
}

function enqueue(job) {
  if (queuedKeys.has(key(job))) return;
  queuedKeys.add(key(job));
  queue.push(job);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      queuedKeys.delete(key(job));
      running--;
      pump();
    });
  }
}

function errorInfo(error) {
  if (error instanceof OcrError || error.code) return { code: error.code, message: error.message };
  return { code: "read_failed", message: error.message || "Reading failed." };
}

async function run({ userId, docId, pageId }) {
  const progress = (step, of, what) =>
    store.updatePage(userId, docId, pageId, { status: "working", progress: what ? { step, of, what } : { step, of } }).catch(() => {});
  try {
    const doc = await store.getDoc(userId, docId);
    if (!doc?.pages.some((p) => p.id === pageId)) return; // removed meanwhile
    await progress(0, 2);
    const imagePath = store.pageImagePath(userId, docId, pageId);
    const image = await store.readPageImage(userId, docId, pageId);
    if (!image) throw Object.assign(new Error("The page image is missing."), { code: "image_missing" });

    let result;
    if (DEMO) {
      for (const step of [1, 2]) {
        await progress(step, 2);
        await new Promise((r) => setTimeout(r, 400));
      }
      result = { lines: demoPage(), source: "local" };
    } else {
      const onDraft = (lines) => store.showDraft(userId, docId, pageId, lines).catch(() => {});
      result = await readWithBestEngine(userId, doc.writerId, imagePath, image, progress, onDraft);
    }
    await store.finishReading(userId, docId, pageId, result.lines, result.source);
  } catch (error) {
    console.error(`Reading failed for page ${pageId}:`, error);
    const info = errorInfo(error);
    await store.updatePage(userId, docId, pageId, { status: "error", progress: null, draft: null, error: info.message, errorCode: info.code }).catch(() => {});
  }
}

/** After a restart, carry on with pages that were waiting or being read. */
export async function resumeReading() {
  const pages = await store.busyPages();
  for (const job of pages) enqueue(job);
  if (pages.length) console.log(`Resuming ${pages.length} page(s) that were being read.`);
}
