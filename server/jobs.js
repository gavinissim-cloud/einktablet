import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { learningFor } from "./learning.js";
import { transcribePage, demoPage } from "./transcribe.js";

// Pages are read on the server, a few at a time, so reading continues even
// if the person closes the browser. Progress is written into the document.

const CONCURRENCY = Math.max(1, Number(process.env.READ_CONCURRENCY || 2));
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
  if (error instanceof Anthropic.AuthenticationError) return { code: "api_key", message: "The server's Anthropic API key is missing or invalid." };
  if (error instanceof Anthropic.RateLimitError) return { code: "rate_limited", message: "Too many requests right now." };
  if (error instanceof Anthropic.BadRequestError) return { code: "bad_page", message: `The page could not be processed: ${error.message}` };
  if (error instanceof Anthropic.APIError) return { code: "api_error", message: `Claude API error (${error.status}).` };
  return { code: "read_failed", message: error.message || "Reading failed." };
}

async function run({ userId, docId, pageId }) {
  const progress = (step, of) => store.updatePage(userId, docId, pageId, { status: "working", progress: { step, of } }).catch(() => {});
  try {
    const doc = await store.getDoc(userId, docId);
    if (!doc?.pages.some((p) => p.id === pageId)) return; // removed meanwhile
    await progress(0, 3);
    const image = await store.readPageImage(userId, docId, pageId);
    if (!image) throw Object.assign(new Error("The page image is missing."), { code: "image_missing" });

    let lines;
    if (DEMO) {
      for (const step of [1, 2, 3]) {
        await progress(step, 3);
        await new Promise((r) => setTimeout(r, 400));
      }
      lines = demoPage();
    } else {
      const learning = await learningFor(userId, doc.writerId);
      lines = await transcribePage(image, { learning, onProgress: progress });
    }
    await store.finishReading(userId, docId, pageId, lines);
  } catch (error) {
    console.error(`Reading failed for page ${pageId}:`, error);
    const info = error.code === "image_missing" ? { code: "image_missing", message: error.message } : errorInfo(error);
    await store.updatePage(userId, docId, pageId, { status: "error", progress: null, error: info.message, errorCode: info.code }).catch(() => {});
  }
}

/** After a restart, carry on with pages that were waiting or being read. */
export async function resumeReading() {
  const pages = await store.busyPages();
  for (const job of pages) enqueue(job);
  if (pages.length) console.log(`Resuming ${pages.length} page(s) that were being read.`);
}
