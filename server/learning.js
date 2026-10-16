import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, isId } from "./store.js";
import { exampleCrop } from "./images.js";
import { trainWriter } from "./ocr.js";

// Handwriting profiles. Each account has writers (whose handwriting a document
// is in). When someone corrects a line, the line's handwriting and the correct
// text are kept as an example for that writer. They are used two ways:
//  - right away: words misread before are corrected in the next readings;
//  - by training: the reading model is taught this writer's handwriting from
//    the corrected lines, and their pages are read with that personal model.
//
// DATA_DIR/writers/<userId>/writers.json            [{id, name, learn, createdAt, training, model}]
// DATA_DIR/writers/<userId>/<writerId>/examples.json [{id, text, ai, createdAt, updatedAt}]
// DATA_DIR/writers/<userId>/<writerId>/<exampleId>.jpg
// DATA_DIR/writers/<userId>/<writerId>/model.pt      the personal model, once trained

const MAX_EXAMPLES = 2000; // kept per writer (oldest dropped first)
const TRAIN_MIN_LINES = Number(process.env.TRAIN_MIN_LINES || 20); // corrected lines before training is offered
const AUTO_TRAIN_EVERY = Number(process.env.AUTO_TRAIN_EVERY || 25); // new corrections that start training again (0 = never)
const DEMO = process.env.DEMO_MODE === "1";
// Lines first read by Gemini are used to train only when this is "1". Google's
// terms forbid using Gemini to develop competing models; whether training a
// handwriting reader on users' corrections of Gemini's readings falls under
// that is a legal question, so it stays off until the operator decides.
const TRAIN_ON_GEMINI_LINES = process.env.TRAIN_ON_GEMINI_LINES === "1";

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
    writers.map(async (w) => {
      const examples = await readJson(examplesFile(userId, w.id), []);
      return { ...w, exampleCount: examples.length, correctedCount: examples.filter((e) => e.corrected !== false).length };
    })
  );
}

export const canTrain = (exampleCount) => exampleCount >= TRAIN_MIN_LINES;
export const TRAINING_MIN = TRAIN_MIN_LINES;

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
 * correction when its text differs from what the engine read (`ai`). Changing a
 * line back to that same reading removes the example again; reading the page
 * again never does (what was learned stays until "Forget").
 * `pageImage(pageId)` returns the stored page image (Buffer) or null.
 */
export async function learnFromDocument(userId, writerId, docId, pages, pageImage) {
  if (!isId(writerId)) return;
  await locked(userId, async () => {
    const writer = (await readJson(writersFile(userId), [])).find((w) => w.id === writerId);
    if (!writer || !writer.learn) return;
    const file = examplesFile(userId, writerId);
    const list = await readJson(file, []);
    const byId = new Map(list.map((e) => [e.id, e]));
    let changed = false;
    const now = new Date().toISOString();

    for (const page of pages) {
      if (page.status !== "done") continue;
      const readable = page.lines.filter((l) => typeof l.ai === "string" && l.top != null);
      const isCorrected = (l) => Boolean(l.text.trim()) && l.text.trim() !== l.ai.trim();
      // A page the person corrected counts as reviewed: its untouched lines are
      // kept too, as confirmed readings. They make fair comparisons possible
      // (corrected lines alone are only the ones the reader got wrong) and
      // give training more to learn from.
      const reviewed = readable.some(isCorrected);
      let image; // loaded only when a new crop is needed
      for (const line of readable) {
        const id = exampleId(page.id, line);
        const existing = byId.get(id);
        const corrected = isCorrected(line);
        if (!reviewed) {
          // Nothing corrected (any more) on this page: forget what this reading taught.
          if (existing && existing.rev === (page.readRev || 0)) {
            byId.delete(id);
            await fs.rm(exampleImagePath(userId, writerId, id), { force: true });
            changed = true;
          }
          continue;
        }
        if (existing) {
          if (existing.text !== line.text || existing.corrected !== corrected) {
            Object.assign(existing, { text: line.text, corrected, updatedAt: now });
            changed = true;
          }
          continue;
        }
        if (image === undefined) image = await pageImage(page.id);
        if (!image) continue;
        await fs.mkdir(writerDir(userId, writerId), { recursive: true });
        await fs.writeFile(exampleImagePath(userId, writerId, id), await exampleCrop(image, line));
        byId.set(id, {
          id, docId, text: line.text, ai: line.ai, corrected, source: line.source || "local",
          rev: page.readRev || 0, createdAt: now, updatedAt: now,
        });
        changed = true;
      }
    }
    if (!changed) return;
    let next = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const old of next.slice(MAX_EXAMPLES)) await fs.rm(exampleImagePath(userId, writerId, old.id), { force: true });
    next = next.slice(0, MAX_EXAMPLES);
    await writeJson(file, next);
  });
  await maybeAutoTrain(userId, writerId);
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

/** Word-level differences between what the engine read and the correct text. */
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

/** Words misread before in this writer's handwriting: [{from, to, count}]. */
async function fixesFor(userId, writerId) {
  const counts = new Map();
  for (const e of await listExamples(userId, writerId)) {
    for (const f of wordFixes(e.ai, e.text)) {
      if (!f.from || !f.to) continue;
      const key = `${f.from}\u0000${f.to}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  // When one misreading was corrected to different words, the commonest wins.
  const best = new Map();
  for (const [key, count] of counts) {
    const [from, to] = key.split("\u0000");
    if (!best.has(from) || best.get(from).count < count) best.set(from, { from, to, count });
  }
  return [...best.values()];
}

export const writerModelPath = (userId, writerId) => path.join(writerDir(userId, writerId), "model.pt");

/**
 * What the readers use for this writer: their personal model (if trained, and
 * whether it measured better than Gemini), earlier fixes, and recent corrected
 * lines as examples for Gemini.
 */
export async function learningFor(userId, writerId, { exampleImages = 0 } = {}) {
  const writer = writerId && (await getWriter(userId, writerId));
  if (!writer) return { model: null, beatsGemini: false, fixes: [], examples: [] };
  let model = null;
  if (writer.model) {
    try {
      await fs.access(writerModelPath(userId, writerId));
      model = writerModelPath(userId, writerId);
    } catch {}
  }
  const examples = [];
  if (exampleImages) {
    for (const e of await listExamples(userId, writerId)) {
      if (examples.length >= exampleImages) break;
      if (e.corrected === false) continue;
      try {
        examples.push({ ...e, image: await fs.readFile(exampleImagePath(userId, writerId, e.id)) });
      } catch {}
    }
  }
  return { model, beatsGemini: Boolean(model && writer.model?.beatsGemini), fixes: await fixesFor(userId, writerId), examples };
}

// ---------- Training a personal model ----------

const trainQueue = [];
let training = false;

function setTraining(userId, writerId, patch) {
  return locked(userId, async () => {
    const writers = await readJson(writersFile(userId), []);
    const writer = writers.find((w) => w.id === writerId);
    if (!writer) return null;
    Object.assign(writer, patch);
    await writeJson(writersFile(userId), writers);
    return writer;
  });
}

/** Queue training for a writer. Resolves false when there is too little to learn from. */
export async function requestTraining(userId, writerId) {
  const writer = await getWriter(userId, writerId);
  if (!writer) return false;
  const count = (await listExamples(userId, writerId)).length;
  if (!canTrain(count)) return false;
  if (["queued", "running"].includes(writer.training?.status)) return true;
  await setTraining(userId, writerId, { training: { status: "queued", queuedAt: new Date().toISOString(), lines: count } });
  trainQueue.push({ userId, writerId });
  pumpTraining();
  return true;
}

async function maybeAutoTrain(userId, writerId) {
  if (!AUTO_TRAIN_EVERY) return;
  const writer = await getWriter(userId, writerId);
  if (!writer || !writer.learn || ["queued", "running"].includes(writer.training?.status)) return;
  const count = (await listExamples(userId, writerId)).length;
  const trainedOn = writer.model?.lines || 0;
  if (canTrain(count) && count - trainedOn >= AUTO_TRAIN_EVERY) await requestTraining(userId, writerId);
}

async function pumpTraining() {
  if (training || !trainQueue.length) return;
  training = true;
  const { userId, writerId } = trainQueue.shift();
  try {
    await runTraining(userId, writerId);
  } catch (error) {
    console.error("Training failed:", error);
    await setTraining(userId, writerId, { training: { status: "failed", error: error.message, finishedAt: new Date().toISOString() } });
  } finally {
    training = false;
    pumpTraining();
  }
}

async function runTraining(userId, writerId) {
  const examples = await listExamples(userId, writerId);
  const dir = writerDir(userId, writerId);
  const tsv = path.join(dir, "training.tsv");
  const clean = (s) => String(s ?? "").replace(/[\t\n]/g, " ");
  const rows = examples.map((e) => [exampleImagePath(userId, writerId, e.id), clean(e.text), clean(e.ai), e.source || ""].join("\t"));
  await fs.writeFile(tsv, rows.join("\n") + "\n");
  const startedAt = new Date().toISOString();
  await setTraining(userId, writerId, { training: { status: "running", startedAt, step: 0, of: 0, lines: examples.length } });

  let report;
  if (DEMO) {
    for (let step = 1; step <= 4; step++) {
      await new Promise((r) => setTimeout(r, 300));
      await setTraining(userId, writerId, { training: { status: "running", startedAt, step, of: 4, lines: examples.length } });
    }
    report = { kept: false, reason: "demo", lines: examples.length };
  } else {
    let last = 0;
    report = await trainWriter(tsv, writerModelPath(userId, writerId) + ".new", TRAIN_ON_GEMINI_LINES ? "" : "gemini", (step, of) => {
      if (Date.now() - last < 3000 && step !== of) return; // keep writes light
      last = Date.now();
      setTraining(userId, writerId, { training: { status: "running", startedAt, step, of, lines: examples.length } }).catch(() => {});
    });
  }

  const finishedAt = new Date().toISOString();
  const result = {
    before: report.before ?? null, after: report.after ?? null, lines: report.lines, held: report.held ?? 0,
    gemini: report.gemini ?? null, personalOnGemini: report.personal_on_gemini ?? null, compared: report.compared ?? 0,
  };
  // Switch this writer to their own model only when it read the same lines better than Gemini did.
  const beatsGemini = result.compared >= 5 && result.personalOnGemini != null && result.personalOnGemini < result.gemini;
  if (report.kept) {
    await fs.rename(writerModelPath(userId, writerId) + ".new", writerModelPath(userId, writerId));
    await setTraining(userId, writerId, {
      training: { status: "done", finishedAt, ...result, kept: true },
      model: {
        trainedAt: finishedAt, lines: examples.length, before: result.before, after: result.after,
        gemini: result.gemini, personalOnGemini: result.personalOnGemini, compared: result.compared, beatsGemini,
      },
    });
  } else {
    await fs.rm(writerModelPath(userId, writerId) + ".new", { force: true });
    await setTraining(userId, writerId, { training: { status: "done", finishedAt, ...result, kept: false, reason: report.reason || "no_gain" } });
  }
}

/** After a restart, training that was cut off is reported as interrupted. */
export async function markInterruptedTraining() {
  let users;
  try {
    users = await fs.readdir(path.join(DATA_DIR, "writers"), { withFileTypes: true });
  } catch {
    return;
  }
  for (const u of users.filter((e) => e.isDirectory() && isId(e.name))) {
    for (const w of await readJson(writersFile(u.name), [])) {
      if (["queued", "running"].includes(w.training?.status)) {
        await setTraining(u.name, w.id, { training: { status: "failed", error: "interrupted", finishedAt: new Date().toISOString() } });
      }
    }
  }
}
