import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Each document lives in DATA_DIR/docs/<userId>/<docId>/: doc.json holds the
// text and edits, <pageId>.jpg holds each page image.
export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data")
);
const ID = /^[A-Za-z0-9-]{1,64}$/;

export const isId = (id) => typeof id === "string" && ID.test(id);

function userDir(userId) {
  if (!isId(userId)) throw new Error("Invalid id");
  return path.join(DATA_DIR, "docs", userId);
}

function docDir(userId, id) {
  if (!isId(id)) throw new Error("Invalid id");
  return path.join(userDir(userId), id);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readDoc(userId, id) {
  try {
    return JSON.parse(await fs.readFile(path.join(docDir(userId, id), "doc.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const num = (n) => (Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n))) : undefined);
const str = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");

// Page status: "new" (not read yet), "queued", "working", "done" or "error".
// The server alone sets status; reading results arrive with a higher readRev.
export const BUSY = new Set(["queued", "working"]);

const cleanLines = (lines) =>
  (Array.isArray(lines) ? lines : []).slice(0, 500).map((l) => ({
    text: str(l?.text, 5000),
    // What the reading engine first read, so corrections can be learned from.
    ai: typeof l?.ai === "string" ? str(l.ai, 5000) : undefined,
    top: num(l?.top),
    bottom: num(l?.bottom),
    left: num(l?.left),
    right: num(l?.right),
    unclear: Array.isArray(l?.unclear) ? l.unclear.filter((w) => typeof w === "string").slice(0, 50) : [],
  }));

/**
 * Merge the pages the browser sends with what the server knows. The browser
 * owns names, order and edited text; the server owns reading status, and its
 * results win while a page is being read or when they are newer.
 */
function mergePages(serverPages, clientPages) {
  if (!Array.isArray(clientPages)) return serverPages;
  const byId = new Map(serverPages.map((p) => [p.id, p]));
  return clientPages
    .filter((p) => p && isId(p.id))
    .slice(0, 300)
    .map((p) => {
      const server = byId.get(p.id);
      const base = { id: p.id, name: str(p.name, 300) };
      if (!server) return { ...base, status: "new", readRev: 0, lines: [] };
      const serverWins = BUSY.has(server.status) || (server.readRev || 0) > (Number(p.readRev) || 0);
      return {
        ...server,
        ...base,
        lines: serverWins ? server.lines : cleanLines(p.lines),
      };
    });
}

// One change at a time per document: browser saves and reading results.
const docLocks = new Map();
function withDoc(userId, id, fn) {
  const key = `${userId}/${id}`;
  const run = (docLocks.get(key) || Promise.resolve()).then(async () => {
    const doc = await readDoc(userId, id);
    if (!doc) return null;
    const result = await fn(doc);
    if (result === false) return doc; // nothing to write
    doc.updatedAt = new Date().toISOString();
    await writeAtomic(path.join(docDir(userId, id), "doc.json"), JSON.stringify(doc));
    return doc;
  });
  docLocks.set(key, run.catch(() => {}));
  return run;
}

export async function listDocs(userId) {
  let entries;
  try {
    entries = await fs.readdir(userDir(userId), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const docs = await Promise.all(
    entries.filter((e) => e.isDirectory() && isId(e.name)).map((e) => readDoc(userId, e.name).catch(() => null))
  );
  return docs
    .filter(Boolean)
    .map((d) => ({ id: d.id, title: d.title, writerId: d.writerId, createdAt: d.createdAt, updatedAt: d.updatedAt, pageCount: d.pages.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createDoc(userId, { title, writerId } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const doc = { id, title: str(title, 200), writerId: isId(writerId) ? writerId : null, createdAt: now, updatedAt: now, pages: [] };
  await fs.mkdir(docDir(userId, id), { recursive: true });
  await writeAtomic(path.join(docDir(userId, id), "doc.json"), JSON.stringify(doc));
  return doc;
}

export const getDoc = readDoc;

export function saveDoc(userId, id, { title, writerId, pages }) {
  return withDoc(userId, id, (doc) => {
    if (typeof title === "string") doc.title = str(title, 200);
    if (writerId === null || isId(writerId)) doc.writerId = writerId;
    doc.pages = mergePages(doc.pages, pages);
  });
}

/** Change one page's reading state (status, progress, error). */
export function updatePage(userId, id, pageId, patch) {
  return withDoc(userId, id, (doc) => {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return false;
    Object.assign(page, patch);
  });
}

/** Store a finished reading: it replaces the page's lines. */
export function finishReading(userId, id, pageId, lines) {
  return withDoc(userId, id, (doc) => {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return false;
    page.lines = cleanLines(lines.map((l) => ({ ...l, ai: l.text })));
    page.status = "done";
    page.readRev = (page.readRev || 0) + 1;
    delete page.progress;
    delete page.error;
    delete page.errorCode;
  });
}

/** Every page left queued or being read (for picking up after a restart). */
export async function busyPages() {
  const out = [];
  let users;
  try {
    users = await fs.readdir(path.join(DATA_DIR, "docs"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const u of users.filter((e) => e.isDirectory() && isId(e.name))) {
    for (const d of await listDocs(u.name)) {
      const doc = await readDoc(u.name, d.id);
      for (const p of doc?.pages || []) if (BUSY.has(p.status)) out.push({ userId: u.name, docId: d.id, pageId: p.id });
    }
  }
  return out;
}

export async function readPageImage(userId, id, pageId) {
  try {
    return await fs.readFile(pageImagePath(userId, id, pageId));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteDoc(userId, id) {
  await fs.rm(docDir(userId, id), { recursive: true, force: true });
}

export async function savePageImage(userId, id, pageId, buffer) {
  if (!isId(pageId)) throw new Error("Invalid id");
  if (!(await readDoc(userId, id))) return false;
  await writeAtomic(path.join(docDir(userId, id), `${pageId}.jpg`), buffer);
  return true;
}

export function pageImagePath(userId, id, pageId) {
  if (!isId(pageId)) throw new Error("Invalid id");
  return path.join(docDir(userId, id), `${pageId}.jpg`);
}

/**
 * Documents saved before accounts existed sit directly in DATA_DIR/<docId>/.
 * Give them to the first account that is created.
 */
export async function adoptLegacyDocs(userId) {
  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let moved = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !isId(e.name) || e.name === "docs") continue;
    const from = path.join(DATA_DIR, e.name);
    try {
      await fs.access(path.join(from, "doc.json"));
    } catch {
      continue;
    }
    await fs.mkdir(userDir(userId), { recursive: true });
    await fs.rename(from, docDir(userId, e.name));
    moved++;
  }
  return moved;
}
