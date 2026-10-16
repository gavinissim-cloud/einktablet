import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildDocx } from "./docx.js";
import * as store from "./store.js";
import * as learning from "./learning.js";
import { authRoutes, requireUser } from "./auth.js";
import { requestReading, resumeReading } from "./jobs.js";
import { warmUp, MODELS_DIR, localModelAvailable } from "./ocr.js";
import { geminiEnabled } from "./gemini.js";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEMO = process.env.DEMO_MODE === "1";

app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(here, "..", "public")));
// The "legacy" build also runs on older phones and tablets.
app.use("/vendor/pdfjs", express.static(path.join(here, "..", "node_modules", "pdfjs-dist", "legacy", "build")));

// Behind a reverse proxy (nginx, Render, etc.) set TRUST_PROXY=1 so client IPs
// and HTTPS are detected correctly for login throttling and secure cookies.
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

authRoutes(app, {
  onFirstUser: async (userId) => {
    const moved = await store.adoptLegacyDocs(userId);
    if (moved) console.log(`Moved ${moved} document(s) saved before accounts existed to the first account.`);
  },
});
// Everything else under /api needs a logged-in user.
app.use("/api", requireUser);

app.post("/api/export/docx", async (req, res) => {
  try {
    const buffer = await buildDocx(req.body || {});
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="transcription.docx"');
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not build the Word document." });
  }
});

// ---------- Saved documents ----------

app.param("docId", (req, res, next, id) => {
  if (!store.isId(id)) return res.status(400).json({ error: "Invalid document id." });
  next();
});

app.get("/api/documents", async (req, res, next) => {
  try { res.json(await store.listDocs(req.user.id)); } catch (e) { next(e); }
});

app.post("/api/documents", async (req, res, next) => {
  try { res.status(201).json(await store.createDoc(req.user.id, req.body || {})); } catch (e) { next(e); }
});

app.get("/api/documents/:docId", async (req, res, next) => {
  try {
    const doc = await store.getDoc(req.user.id, req.params.docId);
    if (!doc) return res.status(404).json({ error: "Document not found.", code: "doc_not_found" });
    res.json(doc);
  } catch (e) { next(e); }
});

app.put("/api/documents/:docId", async (req, res, next) => {
  try {
    const before = await store.getDoc(req.user.id, req.params.docId);
    const doc = await store.saveDoc(req.user.id, req.params.docId, req.body || {});
    if (!doc) return res.status(404).json({ error: "Document not found.", code: "doc_not_found" });
    res.json({ updatedAt: doc.updatedAt });
    // Learn from the person's corrections, after answering so saving stays quick.
    learning
      .moveDocExamples(req.user.id, before?.writerId, doc.writerId, doc.id)
      .then(() => learning.learnFromDocument(req.user.id, doc.writerId, doc.id, doc.pages, (pageId) => store.readPageImage(req.user.id, doc.id, pageId)))
      .catch((error) => console.error("Learning from corrections failed:", error));
  } catch (e) { next(e); }
});

app.delete("/api/documents/:docId", async (req, res, next) => {
  try { await store.deleteDoc(req.user.id, req.params.docId); res.status(204).end(); } catch (e) { next(e); }
});

app.put(
  "/api/documents/:docId/pages/:pageId/image",
  express.raw({ type: "image/jpeg", limit: "30mb" }),
  async (req, res, next) => {
    if (!store.isId(req.params.pageId) || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Send the page as image/jpeg." });
    }
    try {
      const ok = await store.savePageImage(req.user.id, req.params.docId, req.params.pageId, req.body);
      if (!ok) return res.status(404).json({ error: "Document not found." });
      res.status(204).end();
    } catch (e) { next(e); }
  }
);

app.post("/api/documents/:docId/pages/:pageId/read", async (req, res, next) => {
  if (!store.isId(req.params.pageId)) return res.status(400).json({ error: "Invalid page id." });
  try {
    const ok = await requestReading(req.user.id, req.params.docId, req.params.pageId);
    if (!ok) return res.status(404).json({ error: "Page not found.", code: "doc_not_found" });
    res.status(202).json({ status: "queued" });
  } catch (e) { next(e); }
});

app.get("/api/documents/:docId/pages/:pageId/image", (req, res) => {
  if (!store.isId(req.params.pageId)) return res.status(400).end();
  res.sendFile(store.pageImagePath(req.user.id, req.params.docId, req.params.pageId), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- Handwriting profiles ----------

app.param("writerId", (req, res, next, id) => {
  if (!store.isId(id)) return res.status(400).json({ error: "Invalid writer id." });
  next();
});

app.get("/api/writers", async (req, res, next) => {
  try {
    let writers = await learning.listWriters(req.user.id);
    if (!writers.length) {
      // Everyone starts with a profile for their own handwriting.
      await learning.createWriter(req.user.id, req.user.username);
      writers = await learning.listWriters(req.user.id);
    }
    res.json(writers.map((w) => ({ ...w, canTrain: learning.canTrain(w.exampleCount), trainMin: learning.TRAINING_MIN })));
  } catch (e) { next(e); }
});

app.post("/api/writers", async (req, res, next) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the writer a name.", code: "writer_name" });
  try { res.status(201).json(await learning.createWriter(req.user.id, name)); } catch (e) { next(e); }
});

app.patch("/api/writers/:writerId", async (req, res, next) => {
  try {
    const writer = await learning.updateWriter(req.user.id, req.params.writerId, req.body || {});
    if (!writer) return res.status(404).json({ error: "Writer not found.", code: "writer_not_found" });
    res.json(writer);
  } catch (e) { next(e); }
});

app.delete("/api/writers/:writerId", async (req, res, next) => {
  try { await learning.deleteWriter(req.user.id, req.params.writerId); res.status(204).end(); } catch (e) { next(e); }
});

app.post("/api/writers/:writerId/train", async (req, res, next) => {
  try {
    const ok = await learning.requestTraining(req.user.id, req.params.writerId);
    if (!ok) {
      return res.status(400).json({ error: `Correct at least ${learning.TRAINING_MIN} lines first.`, code: "too_few_lines" });
    }
    res.status(202).json({ status: "queued" });
  } catch (e) { next(e); }
});

app.get("/api/writers/:writerId/examples", async (req, res, next) => {
  try { res.json(await learning.listExamples(req.user.id, req.params.writerId)); } catch (e) { next(e); }
});

app.delete("/api/writers/:writerId/examples/:exampleId", async (req, res, next) => {
  if (!store.isId(req.params.exampleId)) return res.status(400).end();
  try { await learning.deleteExample(req.user.id, req.params.writerId, req.params.exampleId); res.status(204).end(); } catch (e) { next(e); }
});

app.get("/api/writers/:writerId/examples/:exampleId/image", (req, res) => {
  if (!store.isId(req.params.exampleId)) return res.status(400).end();
  res.sendFile(learning.exampleImagePath(req.user.id, req.params.writerId, req.params.exampleId), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use("/api", (err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error while saving or loading the document." });
});

if (!DEMO && !localModelAvailable()) {
  console.warn(
    geminiEnabled()
      ? `Note: the free engine has no base model (base.pt) in ${MODELS_DIR}, so pages are read only by Gemini and personal models can't be trained. See the README.`
      : `Warning: no reader is set up. Set GEMINI_API_KEY, or put base.pt in ${MODELS_DIR} (see the README), or run \`npm run demo\` to try the interface.`
  );
}

const server = app.listen(PORT, () => {
  console.log(`Hebrew handwriting converter running at http://localhost:${PORT}${DEMO ? " (demo mode)" : ""}`);
  resumeReading().catch((error) => console.error("Could not resume reading:", error));
  learning.markInterruptedTraining().catch((error) => console.error("Could not check training:", error));
  if (!DEMO && localModelAvailable()) warmUp();
});
server.requestTimeout = 10 * 60 * 1000; // large page uploads on slow connections
