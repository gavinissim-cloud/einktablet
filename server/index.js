import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { transcribePage, demoPage } from "./transcribe.js";
import { buildDocx } from "./docx.js";
import * as store from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEMO = process.env.DEMO_MODE === "1";

app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(here, "..", "public")));
app.use("/vendor/pdfjs", express.static(path.join(here, "..", "node_modules", "pdfjs-dist", "build")));

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

app.post("/api/transcribe", async (req, res) => {
  const { image } = req.body || {};
  const match = typeof image === "string" && image.match(/^data:([^;]+);base64,(.+)$/);
  if (!match || !MEDIA_TYPES.has(match[1])) {
    return res.status(400).json({ error: "Send one page as a JPEG, PNG, WebP or GIF data URL." });
  }
  if (DEMO) return res.json({ lines: demoPage(), demo: true });

  try {
    const lines = await transcribePage(match[2], match[1]);
    res.json({ lines });
  } catch (error) {
    console.error(error);
    let message = error.message || "Transcription failed.";
    let status = 500;
    if (error instanceof Anthropic.AuthenticationError) {
      message = "The server's Anthropic API key is missing or invalid.";
    } else if (error instanceof Anthropic.RateLimitError) {
      message = "Too many requests right now — wait a minute and retry this page.";
      status = 429;
    } else if (error instanceof Anthropic.BadRequestError) {
      message = `The page could not be processed: ${error.message}`;
      status = 400;
    } else if (error instanceof Anthropic.APIError) {
      message = `Claude API error (${error.status}). Please retry.`;
      status = 502;
    }
    res.status(status).json({ error: message });
  }
});

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
  try { res.json(await store.listDocs()); } catch (e) { next(e); }
});

app.post("/api/documents", async (req, res, next) => {
  try { res.status(201).json(await store.createDoc(req.body?.title)); } catch (e) { next(e); }
});

app.get("/api/documents/:docId", async (req, res, next) => {
  try {
    const doc = await store.getDoc(req.params.docId);
    if (!doc) return res.status(404).json({ error: "Document not found." });
    res.json(doc);
  } catch (e) { next(e); }
});

app.put("/api/documents/:docId", async (req, res, next) => {
  try {
    const doc = await store.saveDoc(req.params.docId, req.body || {});
    if (!doc) return res.status(404).json({ error: "Document not found." });
    res.json({ updatedAt: doc.updatedAt });
  } catch (e) { next(e); }
});

app.delete("/api/documents/:docId", async (req, res, next) => {
  try { await store.deleteDoc(req.params.docId); res.status(204).end(); } catch (e) { next(e); }
});

app.put(
  "/api/documents/:docId/pages/:pageId/image",
  express.raw({ type: "image/jpeg", limit: "30mb" }),
  async (req, res, next) => {
    if (!store.isId(req.params.pageId) || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Send the page as image/jpeg." });
    }
    try {
      const ok = await store.savePageImage(req.params.docId, req.params.pageId, req.body);
      if (!ok) return res.status(404).json({ error: "Document not found." });
      res.status(204).end();
    } catch (e) { next(e); }
  }
);

app.get("/api/documents/:docId/pages/:pageId/image", (req, res) => {
  if (!store.isId(req.params.pageId)) return res.status(400).end();
  res.sendFile(store.pageImagePath(req.params.docId, req.params.pageId), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use("/api", (err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error while saving or loading the document." });
});

if (!DEMO && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set — transcription requests will fail. Set it, or run `npm run demo` to try the interface.");
}

app.listen(PORT, () => {
  console.log(`Hebrew handwriting converter running at http://localhost:${PORT}${DEMO ? " (demo mode)" : ""}`);
});
