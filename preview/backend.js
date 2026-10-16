"use strict";
// Backend for the hosted claude.ai preview of the app. It answers the same
// /api/... requests as server/index.js, using the page's claude.ai abilities:
//   db        each person's documents, private to them (data/users/<id>/store/...)
//   assets    the page images
//   sample    Claude reads the handwriting
//   downloads Word / text files
// __SYSTEM__ and __SCHEMA__ are filled in by scripts/build-preview.mjs from
// server/transcribe.js, so both versions read handwriting the same way.

window.HW_BACKEND = (() => {
  const SYSTEM = __SYSTEM__;
  const SCHEMA = __SCHEMA__;
  const PASSES = 2;

  const httpError = (status, message) => Object.assign(new Error(message), { status });

  const ready = (async () => {
    const use = (name) => (window.claude ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
    const [db, user, sample, assets, downloads] = await Promise.all(
      ["db", "user", "sample", "assets", "downloads"].map(use)
    );
    const me = user ? await user.me().catch(() => null) : null;
    return { db, sample, assets, downloads, uid: me?.id || null, name: me?.name || "" };
  })();

  // pageId -> image URL for this visit (asset URL, or a local blob URL when
  // this viewer cannot store assets)
  const images = new Map();

  async function caps() {
    const c = await ready;
    if (!c.db || !c.uid) throw httpError(401, "Not signed in");
    return c;
  }
  // data/users/<id> is the viewer's private collection; "store" is one
  // document in it holding two subcollections.
  const mine = (c) => c.db.doc(`data/users/${c.uid}/store`);
  const docsCol = (c) => mine(c).collection("docs");
  const imagesDoc = (c, docId) => mine(c).collection("images").doc(docId);
  const clean = (value) => JSON.parse(JSON.stringify(value));

  // ---------- Reading handwriting ----------

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(",");
    const type = head.match(/data:([^;]+)/)[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function loadImage(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  }

  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));

  /**
   * Claude receives images of about 1.2 megapixels at most, so besides the
   * whole page send overlapping horizontal strips. Small letters then stay
   * readable. Returns the images and a description of what each strip covers.
   */
  async function pageImages(dataUrl, maxCount) {
    const img = await loadImage(dataUrl);
    const whole = dataUrlToBlob(dataUrl);
    const strips = Math.max(0, Math.min(3, maxCount - 1));
    if (!strips) return { blobs: [whole], note: "" };
    const W = img.naturalWidth, H = img.naturalHeight;
    const overlap = 0.08;
    const blobs = [whole];
    const ranges = [];
    for (let i = 0; i < strips; i++) {
      const top = Math.max(0, i / strips - overlap);
      const bottom = Math.min(1, (i + 1) / strips + overlap);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = Math.round((bottom - top) * H);
      c.getContext("2d").drawImage(img, 0, Math.round(top * H), W, c.height, 0, 0, W, c.height);
      blobs.push(await toBlob(c));
      ranges.push(`image ${i + 2} covers top ${Math.round(top * 1000)} to bottom ${Math.round(bottom * 1000)}`);
    }
    const note = `

You get ${blobs.length} images of the same page. Image 1 is the whole page: give every line's top/bottom/left/right relative to image 1. Images 2–${blobs.length} are zoomed horizontal strips of that page, from top to bottom, for reading small letters (${ranges.join("; ")}, in the same 0–1000 units of image 1). The strips overlap, so a line can appear in two strips: transcribe each line once.`;
    return { blobs, note };
  }

  const clamp = (n) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0)));

  function cleanLine(line) {
    let [top, bottom, left, right] = [line.top, line.bottom, line.left, line.right].map(clamp);
    if (bottom < top) [top, bottom] = [bottom, top];
    if (right < left) [left, right] = [right, left];
    const text = String(line.text || "").trim();
    const words = new Set(text.split(/\s+/));
    const unclear = (Array.isArray(line.unclear) ? line.unclear : []).filter((w) => w && words.has(w));
    return { text, top, bottom, left, right, unclear };
  }

  const FORMAT = `

Reply with only a JSON object matching this JSON Schema, and nothing else:
${JSON.stringify(SCHEMA)}`;

  const SAMPLE_ERRORS = {
    not_granted: "כדי לקרוא כתב יד צריך לאשר לדף הזה להשתמש ב-Claude. טענו את הדף מחדש ובחרו \"אישור\".",
    sampling_disabled: "Claude לא זמין בחשבון הזה.",
    rate_limited: "יותר מדי בקשות כרגע, או שהגעתם למגבלת השימוש. נסו שוב בעוד כמה דקות.",
    session_expired: "צריך להתחבר מחדש ל-claude.ai.",
    image_rejected: "התמונה לא התקבלה. נסו קובץ JPG או PNG אחר.",
    images_unavailable: "בתצוגה הזו אי אפשר לשלוח תמונות ל-Claude.",
    refused: "Claude סירב לקרוא את העמוד הזה.",
    invalid_json: "התשובה של Claude הגיעה בצורה לא תקינה. לחצו \"קריאה מחדש\".",
  };

  async function ask(c, prompt, blobs) {
    try {
      const data = await c.sample.json(prompt, { images: blobs, modelTier: "complex", effort: "high", cache: false });
      if (!data || !Array.isArray(data.lines)) throw { code: "invalid_json" };
      return data.lines.map(cleanLine).filter((l) => l.text);
    } catch (e) {
      throw httpError(502, SAMPLE_ERRORS[e?.code] || "הקריאה נכשלה. לחצו \"קריאה מחדש\".");
    }
  }

  async function transcribe(dataUrl) {
    const c = await caps();
    if (!c.sample) throw httpError(503, "קריאת כתב יד לא זמינה בתצוגה הזו.");
    const limits = await c.sample.limits().catch(() => null);
    if (!limits?.images) throw httpError(503, SAMPLE_ERRORS.images_unavailable);
    const { blobs, note } = await pageImages(dataUrl, limits.images.maxCount);

    let lines = await ask(c, `${SYSTEM}${note}\n\nTranscribe all the handwriting on this page.${FORMAT}`, blobs);
    for (let pass = 2; pass <= PASSES && lines.length; pass++) {
      const draft = lines
        .map((l, i) => `${i + 1}. [top ${l.top}, bottom ${l.bottom}, left ${l.left}, right ${l.right}] ${l.text}`)
        .join("\n");
      lines = await ask(
        c,
        `${SYSTEM}${note}

Below is a draft transcription of this page made by another reader. It may contain misread letters, wrong words, missed or extra lines, missing punctuation (״ ׳ ־ parentheses, dashes) or inaccurate line boxes.

Proofread it against the handwriting: go through the image line by line and word by word, compare every word with the pen strokes, and return the corrected full transcription. Keep what the draft got right; fix everything it got wrong.

Draft:
${draft}${FORMAT}`,
        blobs
      );
    }
    return { lines };
  }

  // ---------- Word export (same layout as server/docx.js) ----------

  async function buildDocx({ pages, withImages }) {
    const d = window.docx;
    if (!d) throw httpError(503, "רכיב ה-Word לא נטען. טענו את הדף מחדש.");
    const FONT = "Arial";
    const para = (text, { size = 26, bold = false } = {}) =>
      new d.Paragraph({
        bidirectional: true,
        alignment: d.AlignmentType.START,
        spacing: { after: 120 },
        children: [new d.TextRun({ text, rightToLeft: true, font: { name: FONT, hint: "cs" }, size, sizeComplexScript: size, bold, boldComplexScript: bold })],
      });
    const none = { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const borders = { top: none, left: none, right: none, bottom: { style: d.BorderStyle.SINGLE, size: 2, color: "DDDDDD" } };
    const children = [];
    pages.forEach((page, i) => {
      if (pages.length > 1) children.push(para(`עמוד ${i + 1}`, { size: 22, bold: true }));
      if (!withImages) {
        page.lines.forEach((l) => children.push(para(l.text)));
        return;
      }
      const rows = page.lines.map((l) => {
        let imageCell = [new d.Paragraph("")];
        if (l.image) {
          const scale = Math.min(1, 300 / (l.width || 300));
          const bytes = new Uint8Array(atob(l.image.split(",")[1]).split("").map((ch) => ch.charCodeAt(0)));
          imageCell = [new d.Paragraph({ children: [new d.ImageRun({ type: "jpg", data: bytes, transformation: { width: Math.round((l.width || 300) * scale), height: Math.round((l.height || 60) * scale) } })] })];
        }
        return new d.TableRow({
          children: [
            new d.TableCell({ borders, width: { size: 50, type: d.WidthType.PERCENTAGE }, children: [para(l.text)] }),
            new d.TableCell({ borders, width: { size: 50, type: d.WidthType.PERCENTAGE }, children: imageCell }),
          ],
        });
      });
      if (rows.length) children.push(new d.Table({ visuallyRightToLeft: true, width: { size: 100, type: d.WidthType.PERCENTAGE }, rows }));
    });
    const doc = new d.Document({
      styles: { default: { document: { run: { font: FONT, rightToLeft: true } } } },
      sections: [{ children }],
    });
    return d.Packer.toBlob(doc);
  }

  // ---------- Requests ----------

  async function request(method, url, body) {
    const route = `${method} ${url}`;
    let m;

    if (route === "GET /api/auth/me") {
      const c = await ready;
      return { user: c.db && c.uid ? { username: c.name || "החשבון שלי" } : null, signupNeedsCode: false };
    }

    if (route === "POST /api/transcribe") return transcribe(body.image);
    if (route === "POST /api/export/docx") return buildDocx(body);

    const c = await caps();

    if (route === "GET /api/documents") {
      const snap = await docsCol(c).get();
      return snap.docs
        .map((s) => s.data())
        .map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, pageCount: (d.pages || []).length }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    if (route === "POST /api/documents") {
      const now = new Date().toISOString();
      const doc = { id: crypto.randomUUID(), title: String(body?.title || "").slice(0, 200) || "מסמך ללא שם", createdAt: now, updatedAt: now, pages: [] };
      await docsCol(c).doc(doc.id).set(doc);
      return doc;
    }

    if ((m = route.match(/^GET \/api\/documents\/([\w-]+)$/))) {
      const snap = await docsCol(c).doc(m[1]).get();
      if (!snap.exists) throw httpError(404, "המסמך לא נמצא.");
      const imgs = (await imagesDoc(c, m[1]).get()).data() || {};
      for (const [pageId, assetId] of Object.entries(imgs)) images.set(pageId, `/_blob/${assetId}`);
      return clean(snap.data());
    }

    if ((m = route.match(/^PUT \/api\/documents\/([\w-]+)$/))) {
      const ref = docsCol(c).doc(m[1]);
      const updatedAt = new Date().toISOString();
      try {
        await ref.update(clean({ title: String(body.title || "").slice(0, 200), pages: body.pages, updatedAt }));
      } catch (e) {
        if (e?.code === "invalid_argument" && !(await ref.get()).exists) throw httpError(404, "המסמך נמחק.");
        if (e?.code === "invalid_argument") throw httpError(400, "המסמך גדול מדי לשמירה. חלקו אותו לשני מסמכים.");
        throw httpError(503, "השמירה נכשלה.");
      }
      return { updatedAt };
    }

    if ((m = route.match(/^DELETE \/api\/documents\/([\w-]+)$/))) {
      const imgRef = imagesDoc(c, m[1]);
      const imgs = (await imgRef.get()).data() || {};
      if (c.assets) for (const assetId of Object.values(imgs)) await c.assets.delete(assetId).catch(() => {});
      await imgRef.delete();
      await docsCol(c).doc(m[1]).delete();
      return null;
    }

    if ((m = route.match(/^PUT \/api\/documents\/([\w-]+)\/pages\/([\w-]+)\/image$/))) {
      const [, docId, pageId] = m;
      if (!c.assets) {
        // This viewer cannot store files: keep the image for this visit only.
        images.set(pageId, URL.createObjectURL(body));
        return null;
      }
      const { id } = await c.assets.upload(body, { type: "image/jpeg" });
      images.set(pageId, `/_blob/${id}`);
      const ref = imagesDoc(c, docId);
      const current = (await ref.get()).data() || {};
      await ref.set({ ...current, [pageId]: id });
      return null;
    }

    if (route.startsWith("POST /api/auth/")) return null;
    throw httpError(404, "Unknown request");
  }

  async function download(blob, filename) {
    const { downloads } = await ready;
    if (!downloads) throw new Error("הורדת קבצים לא זמינה בתצוגה הזו.");
    try {
      await downloads.save({ filename, data: blob });
    } catch (e) {
      if (e?.code === "declined") return;
      throw new Error("ההורדה נכשלה.");
    }
  }

  return {
    request,
    download,
    pageImageUrl: (doc, page) => images.get(page.id) || null,
    externalAuth: true,
    signedOutMessage: "כדי לשמור מסמכים ולקרוא כתב יד, התחברו ל-claude.ai ופתחו את הדף שוב.",
  };
})();
