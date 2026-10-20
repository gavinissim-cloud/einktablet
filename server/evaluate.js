import * as store from "./store.js";
import { learningFor, getWriter, setWriterFields } from "./learning.js";
import { generalLessons } from "./lessons.js";
import { readPageGemini, geminiEnabled, GEMINI_SETTINGS } from "./gemini.js";

// "Check accuracy" for one writer: re-read their pages that a person corrected,
// and compare with the corrected text. Three numbers come out:
//  - first: how the pages were read when they were uploaded;
//  - now: reading them today, with everything learned since (the writer's
//    examples from OTHER documents only, so a page never learns from itself);
//  - fast: the same with less thinking, to see whether it would be as accurate.
// Each page is read twice by Gemini, so a check costs Gemini usage.

const MAX_PAGES = Number(process.env.CHECK_PAGES || 5);
const FASTER = { HIGH: "MEDIUM", MEDIUM: "LOW", LOW: "MINIMAL" };

const running = new Set();
export const isChecking = (userId, writerId) => running.has(`${userId}/${writerId}`);

/** Treat ״ and ", ׳ and ', maqaf and dashes alike, and ignore spacing. */
const normalize = (s) =>
  s.replace(/״/g, '"').replace(/׳/g, "'").replace(/[־–—]/g, "-").replace(/\s+/g, " ").trim();

function distance(a, b) {
  if (a === b) return 0;
  let prev = new Uint32Array(b.length + 1).map((_, j) => j);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

const pageText = (lines, field) => normalize(lines.map((l) => l[field] || "").join(" "));

/** Pages of this writer that a person corrected, newest documents first. */
async function correctedPages(userId, writerId) {
  const out = [];
  for (const d of await store.listDocs(userId)) {
    if (d.writerId !== writerId) continue;
    const doc = await store.getDoc(userId, d.id);
    for (const page of doc?.pages || []) {
      if (page.status !== "done") continue;
      const readable = page.lines.filter((l) => typeof l.ai === "string");
      if (!readable.length || !readable.some((l) => l.text.trim() !== l.ai.trim())) continue;
      out.push({ docId: doc.id, page });
      if (out.length >= MAX_PAGES) return out;
    }
  }
  return out;
}

/** Start a check. Resolves with an error code, or null when it started. */
export async function startCheck(userId, writerId) {
  if (!geminiEnabled()) return "gemini_off";
  if (!(await getWriter(userId, writerId))) return "writer_not_found";
  const key = `${userId}/${writerId}`;
  if (running.has(key)) return "check_running";
  const pages = await correctedPages(userId, writerId);
  if (!pages.length) return "nothing_to_check";
  running.add(key);
  // Recorded before answering, so the page sees the check running at once.
  await setWriterFields(userId, writerId, { check: { state: "running", done: 0, of: pages.length, at: new Date().toISOString() } });
  run(userId, writerId, pages)
    .catch(async (error) => {
      console.error("Accuracy check failed:", error);
      await setWriterFields(userId, writerId, { check: { state: "error", error: error.message, at: new Date().toISOString() } });
    })
    .finally(() => running.delete(key));
  return null;
}

async function run(userId, writerId, pages) {
  const fast = FASTER[GEMINI_SETTINGS.thinking] || null;
  const total = { truth: 0, first: 0, now: 0, fast: 0, nowMs: 0, fastMs: 0, pages: 0 };
  const general = await generalLessons(userId, writerId);
  for (const [i, { docId, page }] of pages.entries()) {
    await setWriterFields(userId, writerId, { check: { state: "running", done: i, of: pages.length, at: new Date().toISOString() } });
    const image = await store.readPageImage(userId, docId, page.id);
    if (!image) continue;
    const truth = pageText(page.lines, "text");
    const learning = await learningFor(userId, writerId, { exampleImages: 24, excludeDocId: docId });
    learning.general = general;

    let started = Date.now();
    const now = await readPageGemini(image, { learning });
    total.nowMs += Date.now() - started;
    let fastLines = null;
    if (fast) {
      started = Date.now();
      fastLines = await readPageGemini(image, { learning, thinking: fast });
      total.fastMs += Date.now() - started;
    }
    total.pages++;
    total.truth += truth.length;
    total.first += distance(pageText(page.lines, "ai"), truth);
    total.now += distance(pageText(now, "text"), truth);
    if (fastLines) total.fast += distance(pageText(fastLines, "text"), truth);
  }
  const pct = (errors) => (total.truth ? Math.round(1000 * (1 - errors / total.truth)) / 10 : null);
  const secs = (ms) => (total.pages ? Math.round(ms / total.pages / 1000) : null);
  await setWriterFields(userId, writerId, {
    check: {
      state: "done",
      at: new Date().toISOString(),
      pages: total.pages,
      first: pct(total.first),
      now: pct(total.now),
      nowSeconds: secs(total.nowMs),
      fastSetting: fast,
      fast: fast ? pct(total.fast) : null,
      fastSeconds: fast ? secs(total.fastMs) : null,
    },
  });
}
