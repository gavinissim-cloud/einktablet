import * as store from "./store.js";
import { learningFor } from "./learning.js";
import { readPage, OcrError } from "./ocr.js";
import { demoPage } from "./demo.js";

// Pages are read on the server, one after another, so reading continues even
// if the person closes the browser. Progress is written into the document.
// (The engine itself reads one page at a time using every CPU core.)

const CONCURRENCY = 1;
const DEMO = process.env.DEMO_MODE === "1";

const queue = [];
const queuedKeys = new Set();
let running = 0;
const key = (j) => `${j.userId}/${j.docId}/${j.pageId}`;

/** Ask for a page to be read (again). */
export async function requestReading(userId, docId, pageId) {
  const doc = await store.updatePage(userId, docId, pageId, { status: "queued", progress: null, error: null, errorCode: null });
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
  const progress = (step, of) => store.updatePage(userId, docId, pageId, { status: "working", progress: { step, of } }).catch(() => {});
  try {
    const doc = await store.getDoc(userId, docId);
    if (!doc?.pages.some((p) => p.id === pageId)) return; // removed meanwhile
    await progress(0, 2);
    const imagePath = store.pageImagePath(userId, docId, pageId);
    if (!(await store.readPageImage(userId, docId, pageId))) {
      throw Object.assign(new Error("The page image is missing."), { code: "image_missing" });
    }

    let lines;
    if (DEMO) {
      for (const step of [1, 2]) {
        await progress(step, 2);
        await new Promise((r) => setTimeout(r, 400));
      }
      lines = demoPage();
    } else {
      const { model, fixes } = await learningFor(userId, doc.writerId);
      lines = await readPage(imagePath, { model, fixes, onProgress: progress });
    }
    await store.finishReading(userId, docId, pageId, lines);
  } catch (error) {
    console.error(`Reading failed for page ${pageId}:`, error);
    const info = errorInfo(error);
    await store.updatePage(userId, docId, pageId, { status: "error", progress: null, error: info.message, errorCode: info.code }).catch(() => {});
  }
}

/** After a restart, carry on with pages that were waiting or being read. */
export async function resumeReading() {
  const pages = await store.busyPages();
  for (const job of pages) enqueue(job);
  if (pages.length) console.log(`Resuming ${pages.length} page(s) that were being read.`);
}
