"use strict";

// Long edge of each page image sent for reading. Large enough to keep small
// handwriting legible, small enough to stay inside the API's image limits.
const MAX_EDGE = 2400;
const CONCURRENCY = 2;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
}

const state = { pages: [], view: "lines" };
const $ = (sel) => document.querySelector(sel);

// ---------- File intake ----------

const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
["dragenter", "dragover"].forEach((t) =>
  document.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((t) =>
  document.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.remove("over"); })
);
document.addEventListener("drop", (e) => addFiles([...(e.dataTransfer?.files || [])]));
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile());
  if (files.length) addFiles(files);
});
$("#addMore").addEventListener("click", () => fileInput.click());
$("#clearAll").addEventListener("click", () => {
  if (!confirm("למחוק את כל העמודים ולהתחיל מחדש?")) return;
  state.pages = [];
  render();
});

async function addFiles(files) {
  const accepted = files.filter((f) => f && (f.type.startsWith("image/") || f.type === "application/pdf"));
  if (!accepted.length) {
    if (files.length) alert("אפשר להעלות רק תמונות או קובצי PDF.");
    return;
  }
  $("#upload").hidden = true;
  $("#workspace").hidden = false;
  for (const file of accepted) {
    try {
      const canvases = file.type === "application/pdf" ? await pdfToCanvases(file) : [await imageToCanvas(file)];
      canvases.forEach((canvas, i) => {
        state.pages.push({
          id: crypto.randomUUID(),
          name: canvases.length > 1 ? `${file.name} — עמוד ${i + 1}` : file.name,
          canvas,
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
          status: "queued",
          lines: [],
        });
      });
    } catch (err) {
      console.error(err);
      alert(`לא הצלחנו לפתוח את הקובץ ${file.name}. אם זו תמונת HEIC מאייפון, המירו אותה ל-JPG.`);
    }
  }
  render();
  pump();
}

function fitCanvas(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  return canvas;
}

async function imageToCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = fitCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function pdfToCanvases(file) {
  if (!window.pdfjsLib) throw new Error("PDF reader failed to load");
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = MAX_EDGE / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas);
  }
  return out;
}

// ---------- Transcription queue ----------

let running = 0;
function pump() {
  while (running < CONCURRENCY) {
    const page = state.pages.find((p) => p.status === "queued");
    if (!page) break;
    running++;
    transcribe(page).finally(() => { running--; pump(); });
  }
  updateStatus();
}

async function transcribe(page) {
  page.status = "working";
  page.error = null;
  renderPage(page);
  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: page.dataUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    page.lines = data.lines.map((l) => ({ ...l, ...cropLine(page.canvas, l) }));
    page.status = "done";
  } catch (err) {
    page.status = "error";
    page.error = err.message;
  }
  if (state.pages.includes(page)) renderPage(page);
  updateStatus();
}

/** Cut the handwriting for one line out of the page image. */
function cropLine(canvas, box) {
  const W = canvas.width, H = canvas.height;
  const h = ((box.bottom - box.top) / 1000) * H;
  const padY = Math.max(6, h * 0.2);
  const padX = W * 0.015;
  const x0 = Math.max(0, (box.left / 1000) * W - padX);
  const x1 = Math.min(W, (box.right / 1000) * W + padX);
  const y0 = Math.max(0, (box.top / 1000) * H - padY);
  const y1 = Math.min(H, (box.bottom / 1000) * H + padY);
  const w = Math.max(1, Math.round(x1 - x0));
  const hh = Math.max(1, Math.round(y1 - y0));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hh;
  c.getContext("2d").drawImage(canvas, x0, y0, w, hh, 0, 0, w, hh);
  return { crop: c.toDataURL("image/jpeg", 0.88), cropW: w, cropH: hh };
}

// ---------- Rendering ----------

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    render();
  })
);

function render() {
  const container = $("#pages");
  container.innerHTML = "";
  if (!state.pages.length) {
    $("#upload").hidden = false;
    $("#workspace").hidden = true;
    return;
  }
  for (const page of state.pages) {
    const el = document.createElement("section");
    el.className = "page";
    el.id = `page-${page.id}`;
    container.append(el);
    renderPage(page);
  }
  updateStatus();
}

function renderPage(page) {
  const el = document.getElementById(`page-${page.id}`);
  if (!el) return;
  el.innerHTML = "";

  const head = document.createElement("div");
  head.className = "page-head";
  const title = document.createElement("h2");
  title.textContent = page.name;
  const st = document.createElement("span");
  st.className = "state";
  head.append(title, st);

  const viewBtn = button("הצגת הדף", "secondary", () => openLightbox(page));
  head.append(viewBtn);

  if (page.status === "queued") st.textContent = "ממתין…";
  if (page.status === "working") st.innerHTML = '<span class="spinner"></span>קורא את כתב היד…';
  if (page.status === "error") {
    st.classList.add("err");
    st.textContent = `שגיאה: ${page.error}`;
  }
  if (page.status === "done") {
    const n = page.lines.filter((l) => l.unclear.length).length;
    st.textContent = `${page.lines.length} שורות` + (n ? ` · ${n} לבדיקה` : "");
  }
  if (page.status === "done" || page.status === "error") {
    head.append(button("קריאה מחדש", "secondary", () => {
      if (page.status === "done" && !confirm("קריאה מחדש תחליף את התיקונים שעשיתם בעמוד הזה. להמשיך?")) return;
      page.status = "queued";
      renderPage(page);
      pump();
    }));
  }
  head.append(button("הסרה", "secondary", () => {
    state.pages = state.pages.filter((p) => p !== page);
    render();
  }));
  el.append(head);

  if (page.status !== "done") return;
  if (!page.lines.length) {
    el.insertAdjacentHTML("beforeend", '<div class="empty">לא נמצא כתב יד בעמוד הזה.</div>');
    return;
  }
  if (state.view === "lines") renderLines(page, el);
  else renderDoc(page, el);
}

function renderLines(page, el) {
  el.insertAdjacentHTML("beforeend", '<div class="col-head"><div>כתב היד</div><div>הטקסט (אפשר לערוך)</div></div>');
  page.lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "row" + (line.unclear.length ? " unclear" : "");

    if (line.crop) {
      const img = document.createElement("img");
      img.className = "crop";
      img.src = line.crop;
      img.alt = `כתב יד, שורה ${i + 1}`;
      img.addEventListener("click", () => openLightbox(page, line));
      row.append(img);
    } else {
      row.append(document.createElement("div"));
    }

    const input = document.createElement("textarea");
    input.rows = 1;
    input.dir = "rtl";
    input.lang = "he";
    input.spellcheck = false;
    input.value = line.text;
    const grow = () => { input.style.height = "auto"; input.style.height = `${input.scrollHeight + 2}px`; };
    input.addEventListener("input", () => {
      line.text = input.value.replace(/\n/g, " ");
      grow();
    });
    input.addEventListener("keydown", (e) => {
      // Enter moves to the next line, like a form; each box is one handwritten line.
      if (e.key === "Enter") {
        e.preventDefault();
        row.nextElementSibling?.querySelector("textarea")?.focus();
      }
    });
    row.append(input);
    requestAnimationFrame(grow);

    if (line.unclear.length) {
      const flag = document.createElement("div");
      flag.className = "flag";
      flag.append(`כדאי לבדוק: ${line.unclear.join(", ")}`);
      flag.append(button("נבדק ✓", "", () => {
        line.unclear = [];
        renderPage(page);
      }));
      row.append(flag);
    }
    el.append(row);
  });
}

function renderDoc(page, el) {
  const doc = document.createElement("div");
  doc.className = "doc";
  doc.contentEditable = "true";
  doc.dir = "rtl";
  doc.lang = "he";
  doc.spellcheck = false;
  page.lines.forEach((line, i) => {
    if (i) doc.append("\n");
    appendHighlighted(doc, line.text, line.unclear);
  });
  doc.addEventListener("input", () => {
    const texts = doc.innerText.replace(/\n$/, "").split("\n");
    const old = page.lines;
    page.lines = texts.map((text, i) => {
      const prev = old[i];
      if (!prev) return { text, unclear: [] };
      const words = new Set(text.split(/\s+/));
      return { ...prev, text, unclear: prev.unclear.filter((w) => words.has(w)) };
    });
  });
  el.append(doc);
}

function appendHighlighted(parent, text, unclear) {
  if (!unclear.length) { parent.append(text); return; }
  const set = new Set(unclear);
  text.split(/(\s+)/).forEach((part) => {
    if (set.has(part)) {
      const m = document.createElement("mark");
      m.textContent = part;
      m.title = "כדאי לבדוק";
      parent.append(m);
    } else {
      parent.append(part);
    }
  });
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function updateStatus() {
  const total = state.pages.length;
  const done = state.pages.filter((p) => p.status === "done").length;
  const working = state.pages.filter((p) => p.status === "working" || p.status === "queued").length;
  const errors = state.pages.filter((p) => p.status === "error").length;
  let text = `${done}/${total} עמודים מוכנים`;
  if (working) text += " · עובד…";
  if (errors) text += ` · ${errors} שגיאות`;
  $("#status").textContent = text;
}

// ---------- Lightbox: whole page with the line highlighted ----------

const lightbox = $("#lightbox");
function openLightbox(page, line) {
  $("#lbImg").src = page.dataUrl;
  const box = $("#lbBox");
  if (line && line.top != null) {
    box.hidden = false;
    box.style.top = `${line.top / 10}%`;
    box.style.height = `${(line.bottom - line.top) / 10}%`;
    box.style.left = `${line.left / 10}%`;
    box.style.width = `${(line.right - line.left) / 10}%`;
  } else {
    box.hidden = true;
  }
  lightbox.hidden = false;
  if (line) requestAnimationFrame(() => box.scrollIntoView({ block: "center" }));
}
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox || e.target.closest(".lb-close")) lightbox.hidden = true;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") lightbox.hidden = true; });

// ---------- Export ----------

function finalText(text) {
  if (!$("#plainPunct").checked) return text;
  return text.replace(/״/g, '"').replace(/׳/g, "'").replace(/־/g, "-");
}

function donePages() {
  return state.pages.filter((p) => p.status === "done");
}

function plainText() {
  return donePages()
    .map((p) => p.lines.map((l) => finalText(l.text)).join("\n"))
    .join("\n\n");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$("#exportTxt").addEventListener("click", () => {
  download(new Blob(["﻿" + plainText()], { type: "text/plain;charset=utf-8" }), "transcription.txt");
});

$("#copyAll").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainText());
  $("#copyAll").textContent = "הועתק ✓";
  setTimeout(() => ($("#copyAll").textContent = "העתקה"), 1500);
});

async function exportDocx(withImages, btn) {
  const pages = donePages().map((p) => ({
    lines: p.lines.map((l) => ({
      text: finalText(l.text),
      ...(withImages && l.crop ? { image: l.crop, width: l.cropW, height: l.cropH } : {}),
    })),
  }));
  if (!pages.length) return alert("אין עדיין טקסט לייצוא.");
  btn.disabled = true;
  try {
    const res = await fetch("/api/export/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages, withImages }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    download(await res.blob(), withImages ? "transcription-with-handwriting.docx" : "transcription.docx");
  } catch (err) {
    alert(`הייצוא נכשל: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
$("#exportDocx").addEventListener("click", (e) => exportDocx(false, e.currentTarget));
$("#exportDocxImages").addEventListener("click", (e) => exportDocx(true, e.currentTarget));

window.addEventListener("beforeunload", (e) => {
  if (donePages().length) e.preventDefault();
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".row textarea").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  });
});
