import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Each document lives in DATA_DIR/<id>/: doc.json holds the text and edits,
// <pageId>.jpg holds each page image.
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data")
);
const ID = /^[A-Za-z0-9-]{1,64}$/;

export const isId = (id) => typeof id === "string" && ID.test(id);

function docDir(id) {
  if (!isId(id)) throw new Error("Invalid id");
  return path.join(DATA_DIR, id);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readDoc(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(docDir(id), "doc.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const num = (n) => (Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n))) : undefined);
const str = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");

function cleanPages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((p) => p && isId(p.id))
    .map((p) => ({
      id: p.id,
      name: str(p.name, 300),
      status: ["queued", "working", "done", "error"].includes(p.status) ? p.status : "queued",
      error: p.status === "error" ? str(p.error, 500) : undefined,
      lines: (Array.isArray(p.lines) ? p.lines : []).map((l) => ({
        text: str(l?.text, 5000),
        top: num(l?.top),
        bottom: num(l?.bottom),
        left: num(l?.left),
        right: num(l?.right),
        unclear: Array.isArray(l?.unclear) ? l.unclear.filter((w) => typeof w === "string").slice(0, 50) : [],
      })),
    }));
}

export async function listDocs() {
  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const docs = await Promise.all(
    entries.filter((e) => e.isDirectory() && isId(e.name)).map((e) => readDoc(e.name).catch(() => null))
  );
  return docs
    .filter(Boolean)
    .map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, pageCount: d.pages.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createDoc(title) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const doc = { id, title: str(title, 200) || "מסמך ללא שם", createdAt: now, updatedAt: now, pages: [] };
  await fs.mkdir(docDir(id), { recursive: true });
  await writeAtomic(path.join(docDir(id), "doc.json"), JSON.stringify(doc));
  return doc;
}

export const getDoc = readDoc;

export async function saveDoc(id, { title, pages }) {
  const doc = await readDoc(id);
  if (!doc) return null;
  if (typeof title === "string") doc.title = str(title, 200);
  if (pages !== undefined) doc.pages = cleanPages(pages);
  doc.updatedAt = new Date().toISOString();
  await writeAtomic(path.join(docDir(id), "doc.json"), JSON.stringify(doc));
  return doc;
}

export async function deleteDoc(id) {
  await fs.rm(docDir(id), { recursive: true, force: true });
}

export async function savePageImage(id, pageId, buffer) {
  if (!isId(pageId)) throw new Error("Invalid id");
  if (!(await readDoc(id))) return false;
  await writeAtomic(path.join(docDir(id), `${pageId}.jpg`), buffer);
  return true;
}

export function pageImagePath(id, pageId) {
  if (!isId(pageId)) throw new Error("Invalid id");
  return path.join(docDir(id), `${pageId}.jpg`);
}
