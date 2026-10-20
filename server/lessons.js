import fs from "node:fs/promises";
import { sharingUserIds } from "./auth.js";
import { listWriters, listExamples, exampleImagePath, wordFixes } from "./learning.js";

// What corrections teach the whole product, not only one writer: misreadings
// that happened in several different writers' handwriting, and a few of those
// corrected lines as reference images. Only accounts that allowed their
// corrections to improve the reader for everyone ("share for training") count.
// Each page still gets its own writer's examples first and weighted most;
// these general lessons come before them as background.

const GENERAL_EXAMPLES = Number(process.env.GENERAL_EXAMPLES ?? 8); // reference lines per request (0 = none)
const MIN_WRITERS = 2; // a misreading must have happened for this many writers to count as general
const REFRESH_MS = 10 * 60 * 1000; // rebuilt at least this often
const MIN_REBUILD_MS = Number(process.env.LESSONS_MIN_REBUILD ?? 60) * 1000; // and at most this often after new corrections
const PER_WRITER = 3; // reference lines considered per writer

let cache = null; // { at, fixes: [{from, to, writers:Set}], pool: [{userId, writerId, ...example}] }
let stale = false;
let building = null;

async function build() {
  const fixes = new Map();
  const pool = [];
  for (const userId of await sharingUserIds()) {
    for (const writer of await listWriters(userId)) {
      if (!writer.learn) continue;
      const key = `${userId}/${writer.id}`;
      const corrected = (await listExamples(userId, writer.id)).filter((e) => e.corrected !== false && e.ai && e.ai !== e.text);
      for (const e of corrected) {
        for (const f of wordFixes(e.ai, e.text)) {
          if (!f.from || !f.to) continue;
          const k = `${f.from}\u0000${f.to}`;
          if (!fixes.has(k)) fixes.set(k, { from: f.from, to: f.to, writers: new Set() });
          fixes.get(k).writers.add(key);
        }
      }
      for (const e of corrected.slice(0, PER_WRITER)) pool.push({ ...e, userId, writerId: writer.id, key });
    }
  }
  return { at: Date.now(), fixes: [...fixes.values()], pool };
}

async function current() {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (age < (stale ? MIN_REBUILD_MS : REFRESH_MS)) return cache;
  stale = false;
  building ??= build()
    .then((c) => (cache = c))
    .finally(() => { building = null; });
  return building;
}

/** New corrections were saved: rebuild the lessons soon. */
export function refreshLessons() {
  stale = true;
}

/**
 * General lessons for reading a page by (userId, writerId), leaving out that
 * writer's own lines (they are used separately, and weighted more).
 * Returns {fixes: [{from, to}], examples: [{image, text, ai}]}.
 */
export async function generalLessons(userId, writerId, { images = GENERAL_EXAMPLES } = {}) {
  let data;
  try {
    data = await current();
  } catch (error) {
    console.error("Could not gather general lessons:", error.message);
    return { fixes: [], examples: [] };
  }
  const own = `${userId}/${writerId}`;
  const fixes = data.fixes
    .filter((f) => f.writers.size - (f.writers.has(own) ? 1 : 0) >= MIN_WRITERS)
    .sort((a, b) => b.writers.size - a.writers.size)
    .map(({ from, to }) => ({ from, to }));

  // Reference lines: spread over as many writers as possible, newest first.
  const byWriter = new Map();
  for (const e of data.pool) {
    if (e.key === own) continue;
    if (!byWriter.has(e.key)) byWriter.set(e.key, []);
    byWriter.get(e.key).push(e);
  }
  const queues = [...byWriter.values()];
  const picked = [];
  for (let round = 0; picked.length < images && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && picked.length < images) picked.push(q[round]);
  }
  const examples = [];
  for (const e of picked) {
    try {
      examples.push({ image: await fs.readFile(exampleImagePath(e.userId, e.writerId, e.id)), text: e.text, ai: e.ai });
    } catch {}
  }
  return { fixes, examples };
}
