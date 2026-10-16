"use strict";

// Long edge of each page image sent for reading. Large enough to keep small
// handwriting legible, small enough to stay inside the API's image limits.
const MAX_EDGE = 2400;
const CONCURRENCY = 2;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
}

const state = { user: null, doc: null, view: "lines" };
const $ = (sel) => document.querySelector(sel);
const currentPages = () => state.doc?.pages || [];

// An embedding page (the hosted preview) can supply its own storage, reading
// and downloads by defining window.HW_BACKEND before this script runs.
const backend = window.HW_BACKEND || null;

// ---------- In-page dialogs (instead of the browser's alert/confirm) ----------

function dialog(message, { okLabel = "אישור", cancelLabel = null, danger = false } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog-wrap";
    wrap.innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true"><p class="dialog-msg"></p><div class="dialog-actions"></div></div>';
    wrap.querySelector(".dialog-msg").textContent = message;
    const actions = wrap.querySelector(".dialog-actions");
    const close = (value) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
      resolve(value);
    };
    const ok = button(okLabel, danger ? "danger" : "", () => close(true));
    actions.append(ok);
    if (cancelLabel) actions.append(button(cancelLabel, "secondary", () => close(false)));
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(false); });
    document.body.append(wrap);
    ok.focus();
  });
}
const notify = (message) => dialog(message);
const ask = (message, okLabel = "כן", opts = {}) => dialog(message, { okLabel, cancelLabel: "ביטול", ...opts });

async function api(method, url, body, headers = { "Content-Type": "application/json" }) {
  if (backend) {
    try {
      return await backend.request(method, url, body);
    } catch (err) {
      if (err.status === 401 && !url.startsWith("/api/auth/")) showAuth();
      throw err;
    }
  }
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : headers,
    body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showAuth();
    throw Object.assign(new Error("יש להתחבר מחדש."), { status: 401 });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Server error ${res.status}`), { status: res.status });
  }
  if (res.status === 204) return null;
  return (res.headers.get("Content-Type") || "").includes("json") ? res.json() : res.blob();
}

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
  if (e.target.closest?.("input, textarea, [contenteditable]")) return;
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile());
  if (files.length) addFiles(files);
});
$("#addMore").addEventListener("click", () => fileInput.click());

async function addFiles(files) {
  if (!state.user) return;
  const accepted = files.filter((f) => f && (f.type.startsWith("image/") || f.type === "application/pdf"));
  if (!accepted.length) {
    if (files.length) notify("אפשר להעלות רק תמונות או קובצי PDF.");
    return;
  }
  let doc = state.doc;
  if (!doc) {
    try {
      const created = await api("POST", "/api/documents", { title: accepted[0].name.replace(/\.[^.]+$/, "") });
      doc = adoptDoc(created, []);
    } catch (err) {
      return notify(`לא הצלחנו ליצור מסמך חדש: ${err.message}`);
    }
    showDoc(doc);
  }
  for (const file of accepted) {
    try {
      const canvases = file.type === "application/pdf" ? await pdfToCanvases(file) : [await imageToCanvas(file)];
      for (const [i, canvas] of canvases.entries()) {
        const page = {
          id: crypto.randomUUID(),
          name: canvases.length > 1 ? `${file.name} — עמוד ${i + 1}` : file.name,
          canvas,
          status: "queued",
          lines: [],
        };
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        await api("PUT", `/api/documents/${doc.id}/pages/${page.id}/image`, blob, { "Content-Type": "image/jpeg" });
        page.src = pageImageUrl(doc, page);
        doc.pages.push(page);
        scheduleSave(doc);
        if (doc === state.doc) { render(); pump(); }
      }
    } catch (err) {
      console.error(err);
      notify(`לא הצלחנו להוסיף את הקובץ ${file.name}: ${err.message}. אם זו תמונת HEIC מאייפון, המירו אותה ל-JPG.`);
    }
  }
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

// ---------- Saved documents ----------

const pageImageUrl = (doc, page) =>
  backend ? backend.pageImageUrl(doc, page) : `/api/documents/${doc.id}/pages/${page.id}/image`;

function adoptDoc(data, pages) {
  return { id: data.id, title: data.title, pages, timer: null, saving: false, dirty: false, failed: false };
}

function serialize(doc) {
  return {
    title: doc.title,
    pages: doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      error: p.error,
      lines: p.lines.map(({ text, top, bottom, left, right, unclear }) => ({ text, top, bottom, left, right, unclear })),
    })),
  };
}

/** Save shortly after the last change; saves of one document never overlap. */
function scheduleSave(doc, delay = 800) {
  doc.dirty = true;
  clearTimeout(doc.timer);
  doc.timer = setTimeout(() => flushSave(doc), delay);
  updateSaveState();
}

async function flushSave(doc) {
  clearTimeout(doc.timer);
  doc.timer = null;
  if (doc.saving || !doc.dirty) return;
  doc.saving = true;
  doc.dirty = false;
  updateSaveState();
  try {
    await api("PUT", `/api/documents/${doc.id}`, serialize(doc));
    doc.failed = false;
  } catch (err) {
    console.error(err);
    doc.failed = true;
    // A 404 means the document was deleted; retrying cannot help.
    if (err.status !== 404) {
      doc.dirty = true;
      doc.timer = setTimeout(() => flushSave(doc), 5000);
    }
  }
  doc.saving = false;
  if (doc.dirty && !doc.timer) flushSave(doc);
  updateSaveState();
}

const hasUnsaved = (doc) => doc && (doc.dirty || doc.saving);

function updateSaveState() {
  const el = $("#saveState");
  const doc = state.doc;
  if (!doc) return;
  el.classList.toggle("err", doc.failed);
  if (doc.failed) el.textContent = "השמירה נכשלה — מנסה שוב…";
  else if (hasUnsaved(doc)) el.textContent = "שומר…";
  else el.textContent = "כל השינויים נשמרו ✓";
}

async function loadCanvas(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas;
}

let loadingId = null;
async function openDoc(id) {
  if (loadingId === id) return;
  loadingId = id;
  try {
    await loadDoc(id);
  } finally {
    loadingId = null;
  }
}

async function loadDoc(id) {
  let data;
  try {
    data = await api("GET", `/api/documents/${id}`);
  } catch (err) {
    if (err.status !== 401) notify(`לא הצלחנו לפתוח את המסמך: ${err.message}`);
    return showHome();
  }
  const doc = adoptDoc(data, []);
  doc.pages = await Promise.all(
    data.pages.map(async (p) => {
      const page = { ...p, src: pageImageUrl(doc, p) };
      // A reading that was cut off (page closed mid-way) starts again.
      if (page.status === "working") page.status = "queued";
      try {
        if (!page.src) throw new Error("no image");
        page.canvas = await loadCanvas(page.src);
        page.lines = page.lines.map((l) => (l.top == null ? l : { ...l, ...cropLine(page.canvas, l) }));
      } catch {
        page.canvas = null;
        if (page.status !== "done") {
          page.status = "error";
          page.error = "תמונת העמוד לא נשמרה. הסירו את העמוד והעלו אותו שוב.";
        }
      }
      return page;
    })
  );
  if (location.hash !== `#doc=${id}`) return; // the user navigated away while loading
  showDoc(doc);
  pump();
}

function showDoc(doc) {
  if (state.doc && state.doc !== doc) flushSave(state.doc);
  state.doc = doc;
  if (location.hash !== `#doc=${doc.id}`) history.pushState(null, "", `#doc=${doc.id}`);
  $("#upload").hidden = true;
  $("#workspace").hidden = false;
  $("#docTitle").value = doc.title;
  document.title = `${doc.title} — כתב יד לטקסט`;
  render();
  updateSaveState();
}

async function showHome() {
  if (state.doc) flushSave(state.doc);
  state.doc = null;
  if (location.hash) history.pushState(null, "", location.pathname);
  document.title = "כתב יד לטקסט — Hebrew Handwriting to Text";
  $("#upload").hidden = false;
  $("#workspace").hidden = true;
  $("#pages").innerHTML = "";
  await renderDocList();
}

async function renderDocList() {
  const list = $("#docList");
  let docs;
  try {
    docs = await api("GET", "/api/documents");
  } catch (err) {
    list.innerHTML = `<p class="save-state err">לא הצלחנו לטעון את רשימת המסמכים: ${escapeHtml(err.message)}</p>`;
    return;
  }
  list.innerHTML = "";
  if (!docs.length) return;
  list.insertAdjacentHTML("beforeend", "<h2>המסמכים שלי</h2>");
  for (const d of docs) {
    const item = document.createElement("div");
    item.className = "doc-item";
    const link = document.createElement("a");
    link.href = `#doc=${d.id}`;
    link.textContent = d.title || "מסמך ללא שם";
    link.dir = "auto";
    const meta = document.createElement("span");
    meta.className = "meta";
    const when = new Date(d.updatedAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
    meta.textContent = `${d.pageCount} עמודים · עודכן ${when}`;
    item.append(link, meta, button("מחיקה", "secondary", async () => {
      if (!(await ask(`למחוק את המסמך "${d.title}"? אי אפשר לבטל את זה.`, "מחיקה", { danger: true }))) return;
      try {
        await api("DELETE", `/api/documents/${d.id}`);
      } catch (err) {
        notify(`המחיקה נכשלה: ${err.message}`);
      }
      renderDocList();
    }));
    list.append(item);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function route() {
  if (!state.user) return;
  const id = location.hash.match(/^#doc=([A-Za-z0-9-]+)$/)?.[1];
  if (!id) return showHome();
  if (state.doc?.id !== id) openDoc(id);
}
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

$("#backHome").addEventListener("click", showHome);
$("#docTitle").addEventListener("input", () => {
  if (!state.doc) return;
  state.doc.title = $("#docTitle").value;
  document.title = `${state.doc.title} — כתב יד לטקסט`;
  scheduleSave(state.doc);
});

// ---------- Login ----------

let authMode = "login";
let signupNeedsCode = false;

function setAuthMode(mode) {
  authMode = mode;
  const register = mode === "register";
  $("#authTitle").textContent = register ? "הרשמה" : "התחברות";
  $("#authSubmit").textContent = register ? "יצירת חשבון" : "התחברות";
  $("#authSwitchText").textContent = register ? "כבר יש לכם חשבון?" : "אין לכם חשבון?";
  $("#authSwitch").textContent = register ? "התחברות" : "הרשמה";
  $("#authPass").autocomplete = register ? "new-password" : "current-password";
  $("#authCodeRow").hidden = !(register && signupNeedsCode);
  $("#authError").textContent = "";
}

function showAuth() {
  if (backend?.externalAuth) {
    $("#account").hidden = true;
    $("#upload").hidden = true;
    $("#workspace").hidden = true;
    $("#auth").hidden = false;
    $("#authForm").innerHTML = "";
    const msg = document.createElement("p");
    msg.textContent = backend.signedOutMessage;
    $("#authForm").append(msg);
    return;
  }
  state.user = null;
  state.doc = null;
  $("#account").hidden = true;
  $("#upload").hidden = true;
  $("#workspace").hidden = true;
  $("#pages").innerHTML = "";
  $("#docList").innerHTML = "";
  $("#auth").hidden = false;
  $("#authUser").focus();
}

function signedIn(user) {
  state.user = user;
  $("#auth").hidden = true;
  $("#account").hidden = false;
  $("#accountName").textContent = user.username;
  $("#logout").hidden = Boolean(backend?.externalAuth);
  $("#authPass").value = "";
  $("#authCode").value = "";
  route();
}

$("#authSwitch").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "login" ? "register" : "login");
});

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#authSubmit");
  submit.disabled = true;
  $("#authError").textContent = "";
  try {
    const body = { username: $("#authUser").value, password: $("#authPass").value };
    if (authMode === "register") body.code = $("#authCode").value;
    const data = await api("POST", `/api/auth/${authMode}`, body);
    signedIn(data.user);
  } catch (err) {
    $("#authError").textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  const doc = state.doc;
  if (doc && hasUnsaved(doc)) {
    await flushSave(doc);
    if (hasUnsaved(doc) && !(await ask("יש שינויים שעדיין לא נשמרו. להתנתק בכל זאת?", "התנתקות"))) return;
  }
  await api("POST", "/api/auth/logout", {}).catch(() => {});
  if (location.hash) history.pushState(null, "", location.pathname);
  setAuthMode("login");
  showAuth();
});

async function start() {
  try {
    const me = await api("GET", "/api/auth/me");
    signupNeedsCode = me.signupNeedsCode;
    setAuthMode("login");
    if (me.user) signedIn(me.user);
    else showAuth();
  } catch (err) {
    notify(`השרת לא זמין: ${err.message}`);
  }
}

// ---------- Transcription queue ----------

let running = 0;
function pump() {
  const doc = state.doc;
  while (doc && running < CONCURRENCY) {
    const page = doc.pages.find((p) => p.status === "queued" && p.canvas);
    if (!page) break;
    running++;
    transcribe(page, doc).finally(() => { running--; pump(); });
  }
  updateStatus();
}

async function transcribe(page, doc) {
  page.status = "working";
  page.error = undefined;
  renderPage(page);
  scheduleSave(doc);
  try {
    const data = await api("POST", "/api/transcribe", { image: page.canvas.toDataURL("image/jpeg", 0.92) });
    page.lines = data.lines.map((l) => ({ ...l, ...cropLine(page.canvas, l) }));
    page.status = "done";
  } catch (err) {
    page.status = "error";
    page.error = err.message;
  }
  // The page may have been removed while it was being read.
  if (!doc.pages.includes(page)) return;
  scheduleSave(doc);
  if (doc === state.doc) {
    renderPage(page);
    updateStatus();
  }
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
  if (!currentPages().length) {
    container.innerHTML = '<div class="page empty">אין עדיין עמודים במסמך. גררו לכאן קובץ או לחצו "+ עמודים נוספים".</div>';
  }
  for (const page of currentPages()) {
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

  if (page.src) head.append(button("הצגת הדף", "secondary", () => openLightbox(page)));

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
    head.append(button("קריאה מחדש", "secondary", async () => {
      if (page.status === "done" && !(await ask("קריאה מחדש תחליף את התיקונים שעשיתם בעמוד הזה. להמשיך?", "קריאה מחדש"))) return;
      page.status = "queued";
      renderPage(page);
      scheduleSave(state.doc);
      pump();
    }));
  }
  head.append(button("הסרה", "secondary", async () => {
    if (page.status === "done" && !(await ask("להסיר את העמוד הזה מהמסמך?", "הסרה", { danger: true }))) return;
    state.doc.pages = state.doc.pages.filter((p) => p !== page);
    scheduleSave(state.doc);
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
      scheduleSave(state.doc);
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
        scheduleSave(state.doc);
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
    scheduleSave(state.doc);
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
  const pages = currentPages();
  const total = pages.length;
  const done = pages.filter((p) => p.status === "done").length;
  const working = pages.filter((p) => p.status === "working" || p.status === "queued").length;
  const errors = pages.filter((p) => p.status === "error").length;
  let text = `${done}/${total} עמודים מוכנים`;
  if (working) text += " · עובד…";
  if (errors) text += ` · ${errors} שגיאות`;
  $("#status").textContent = text;
}

// ---------- Lightbox: whole page with the line highlighted ----------

const lightbox = $("#lightbox");
function openLightbox(page, line) {
  $("#lbImg").src = page.src;
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
  return currentPages().filter((p) => p.status === "done");
}

function plainText() {
  return donePages()
    .map((p) => p.lines.map((l) => finalText(l.text)).join("\n"))
    .join("\n\n");
}

function download(blob, name) {
  if (backend?.download) return backend.download(blob, name);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$("#exportTxt").addEventListener("click", async () => {
  try {
    await download(new Blob(["﻿" + plainText()], { type: "text/plain;charset=utf-8" }), "transcription.txt");
  } catch (err) {
    notify(`ההורדה נכשלה: ${err.message}`);
  }
});

$("#copyAll").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(plainText());
  } catch {
    return notify("ההעתקה לא הצליחה בדפדפן הזה. עברו לתצוגת \"מסמך\", סמנו את הטקסט והעתיקו ידנית.");
  }
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
  if (!pages.length) return notify("אין עדיין טקסט לייצוא.");
  btn.disabled = true;
  try {
    const blob = await api("POST", "/api/export/docx", { pages, withImages });
    await download(blob, withImages ? "transcription-with-handwriting.docx" : "transcription.docx");
  } catch (err) {
    if (err.status !== 401) notify(`הייצוא נכשל: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
$("#exportDocx").addEventListener("click", (e) => exportDocx(false, e.currentTarget));
$("#exportDocxImages").addEventListener("click", (e) => exportDocx(true, e.currentTarget));

// Leaving the page: start any pending save now, and warn while one is still in flight.
window.addEventListener("beforeunload", (e) => {
  const doc = state.doc;
  if (!doc) return;
  if (doc.dirty && !doc.saving) flushSave(doc);
  if (hasUnsaved(doc) || running > 0) e.preventDefault();
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".row textarea").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  });
});

start();
