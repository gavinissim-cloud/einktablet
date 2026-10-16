import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, isId } from "./store.js";
import { exampleCrop } from "./images.js";

// Handwriting profiles. Each account has writers (whose handwriting a document
// is in). When someone corrects a line, the line's handwriting and the correct
// text are kept as an example for that writer and shown to Claude next time.
//
// DATA_DIR/writers/<userId>/writers.json            [{id, name, learn, createdAt}]
// DATA_DIR/writers/<userId>/<writerId>/examples.json [{id, text, ai, createdAt, updatedAt}]
// DATA_DIR/writers/<userId>/<writerId>/<exampleId>.jpg

const MAX_EXAMPLES = 400; // kept per writer (oldest dropped first)
export const PROMPT_EXAMPLES = Number(process.env.LEARNING_EXAMPLES || 24); // images shown per request

const userDir = (userId) => {
  if (!isId(userId)) throw new Error("Invalid id");
  return path.join(DATA_DIR, "writers", userId);
};
const writerDir = (userId, writerId) => {
  if (!isId(writerId)) throw new Error("Invalid id");
  return path.join(userDir(userId), writerId);
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

// One write at a time per user, so concurrent saves never lose an example.
const chains = new Map();
function locked(userId, fn) {
  const run = (chains.get(userId) || Promise.resolve()).then(fn);
  chains.set(userId, run.catch(() => {}));
  return run;
}

const writersFile = (userId) => path.join(userDir(userId), "writers.json");
const examplesFile = (userId, writerId) => path.join(writerDir(userId, writerId), "examples.json");

export async function listWriters(userId) {
  const writers = await readJson(writersFile(userId), []);
  return Promise.all(
    writers.map(async (w) => ({ ...w, exampleCount: (await readJson(examplesFile(userId, w.id), [])).length }))
  );
}

export async function getWriter(userId, writerId) {
  if (!isId(writerId)) return null;
  return (await readJson(writersFile(userId), [])).find((w) => w.id === writerId) || null;
}

export function createWriter(userId, name) {
  return locked(userId, async () => {
    const writers = await readJson(writersFile(userId), []);
    const writer = { id: crypto.randomUUID(), name: String(name || "").trim().slice(0, 100), learn: true, createdAt: new Date().toISOString() };
    writers.push(writer);
    await writeJson(writersFile(userId), writers);
    return writer;
  });
}

export function updateWriter(userId, writerId, { name, learn }) {
  return locked(userId, async () => {
    const writers = await readJson(writersFile(userId), []);
    const writer = writers.find((w) => w.id === writerId);
    if (!writer) return null;
    if (typeof name === "string") writer.name = name.trim().slice(0, 100);
    if (typeof learn === "boolean") writer.learn = learn;
    await writeJson(writersFile(userId), writers);
    return writer;
  });
}

export function deleteWriter(userId, writerId) {
  return locked(userId, async () => {
    const writers = await readJson(writersFile(userId), []);
    await writeJson(writersFile(userId), writers.filter((w) => w.id !== writerId));
    await fs.rm(writerDir(userId, writerId), { recursive: true, force: true });
  });
}

export async function listExamples(userId, writerId) {
  return (await readJson(examplesFile(userId, writerId), [])).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function exampleImagePath(userId, writerId, exampleId) {
  if (!isId(exampleId)) throw new Error("Invalid id");
  return path.join(writerDir(userId, writerId), `${exampleId}.jpg`);
}

export function deleteExample(userId, writerId, exampleId) {
  return locked(userId, async () => {
    const list = await readJson(examplesFile(userId, writerId), []);
    await writeJson(examplesFile(userId, writerId), list.filter((e) => e.id !== exampleId));
    await fs.rm(exampleImagePath(userId, writerId, exampleId), { force: true });
  });
}

/** A stable id for one line on one page, so editing it again updates the same example. */
function exampleId(pageId, box) {
  return crypto
    .createHash("sha256")
    .update(`${pageId}:${box.top}:${box.bottom}:${box.left}:${box.right}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Record what the person corrected on a saved document. A line counts as a
 * correction when its text differs from what Claude read (`ai`). Changing a
 * line back to that same reading removes the example again; reading the page
 * again never does (what was learned stays until "Forget").
 * `pageImage(pageId)` returns the stored page image (Buffer) or null.
 */
export function learnFromDocument(userId, writerId, docId, pages, pageImage) {
  if (!isId(writerId)) return Promise.resolve();
  return locked(userId, async () => {
    const writer = (await readJson(writersFile(userId), [])).find((w) => w.id === writerId);
    if (!writer || !writer.learn) return;
    const file = examplesFile(userId, writerId);
    const list = await readJson(file, []);
    const byId = new Map(list.map((e) => [e.id, e]));
    let changed = false;
    const now = new Date().toISOString();

    for (const page of pages) {
      if (page.status !== "done") continue;
      let image; // loaded only when a new crop is needed
      for (const line of page.lines) {
        if (typeof line.ai !== "string" || line.top == null) continue;
        const id = exampleId(page.id, line);
        const existing = byId.get(id);
        const corrected = line.text.trim() && line.text.trim() !== line.ai.trim();
        if (!corrected) {
          if (existing && existing.rev === (page.readRev || 0)) {
            byId.delete(id);
            await fs.rm(exampleImagePath(userId, writerId, id), { force: true });
            changed = true;
          }
          continue;
        }
        if (existing) {
          if (existing.text !== line.text) {
            existing.text = line.text;
            existing.updatedAt = now;
            changed = true;
          }
          continue;
        }
        if (image === undefined) image = await pageImage(page.id);
        if (!image) continue;
        await fs.mkdir(writerDir(userId, writerId), { recursive: true });
        await fs.writeFile(exampleImagePath(userId, writerId, id), await exampleCrop(image, line));
        byId.set(id, { id, docId, text: line.text, ai: line.ai, rev: page.readRev || 0, createdAt: now, updatedAt: now });
        changed = true;
      }
    }
    if (!changed) return;
    let next = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const old of next.slice(MAX_EXAMPLES)) await fs.rm(exampleImagePath(userId, writerId, old.id), { force: true });
    next = next.slice(0, MAX_EXAMPLES);
    await writeJson(file, next);
  });
}

/**
 * A document was switched to another writer: its corrections were in the new
 * writer's handwriting all along, so move them there.
 */
export function moveDocExamples(userId, fromWriterId, toWriterId, docId) {
  if (!isId(fromWriterId) || !isId(toWriterId) || fromWriterId === toWriterId) return Promise.resolve();
  return locked(userId, async () => {
    if (!(await readJson(writersFile(userId), [])).some((w) => w.id === toWriterId)) return;
    const from = await readJson(examplesFile(userId, fromWriterId), []);
    const moving = from.filter((e) => e.docId === docId);
    if (!moving.length) return;
    const to = await readJson(examplesFile(userId, toWriterId), []);
    await fs.mkdir(writerDir(userId, toWriterId), { recursive: true });
    for (const e of moving) {
      await fs.rename(exampleImagePath(userId, fromWriterId, e.id), exampleImagePath(userId, toWriterId, e.id)).catch(() => {});
    }
    const ids = new Set(moving.map((e) => e.id));
    await writeJson(examplesFile(userId, toWriterId), [...moving, ...to.filter((e) => !ids.has(e.id))]);
    await writeJson(examplesFile(userId, fromWriterId), from.filter((e) => !ids.has(e.id)));
  });
}

/** Word-level differences between what Claude read and the correct text. */
export function wordFixes(ai, text) {
  const a = ai.split(/\s+/).filter(Boolean);
  const b = text.split(/\s+/).filter(Boolean);
  // Longest common subsequence of words; the gaps between matches are the fixes.
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const fixes = [];
  let i = 0, j = 0, gapA = [], gapB = [];
  const flush = () => {
    if (gapA.length || gapB.length) fixes.push({ from: gapA.join(" "), to: gapB.join(" ") });
    gapA = []; gapB = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) gapB.push(b[j++]);
    else gapA.push(a[i++]);
  }
  flush();
  return fixes;
}

/**
 * What Claude is shown about this writer: the most recent corrected lines
 * (image + correct text) and a list of words it misread before.
 */
export async function learningFor(userId, writerId) {
  if (!writerId || !(await getWriter(userId, writerId))) return null;
  const examples = await listExamples(userId, writerId);
  if (!examples.length) return null;

  const shown = [];
  for (const e of examples) {
    if (shown.length >= PROMPT_EXAMPLES) break;
    try {
      shown.push({ ...e, image: await fs.readFile(exampleImagePath(userId, writerId, e.id)) });
    } catch {}
  }

  const counts = new Map();
  for (const e of examples) {
    for (const f of wordFixes(e.ai, e.text)) {
      const key = `${f.from} → ${f.to}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const fixes = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 150).map(([k, n]) => (n > 1 ? `${k} (${n}×)` : k));
  return { examples: shown, fixes, total: examples.length };
}
