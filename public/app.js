"use strict";

// Long edge of each stored page image. The reading engine finds the lines on
// the full-size page, so keep as much detail as phones give.
const MAX_EDGE = 4000;
const POLL_MS = 2500;

const state = { user: null, doc: null, view: "lines", writers: [] };
const $ = (sel) => document.querySelector(sel);
const currentPages = () => state.doc?.pages || [];

// ---------- In-page dialogs (instead of the browser's alert/confirm) ----------

function dialog(message, { okLabel = t("ok"), cancelLabel = null, danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog-wrap";
    wrap.innerHTML = '<form class="dialog" role="alertdialog" aria-modal="true"><p class="dialog-msg"></p><div class="dialog-actions"></div></form>';
    wrap.querySelector(".dialog-msg").textContent = message;
    const form = wrap.querySelector("form");
    let field = null;
    if (input !== null) {
      field = document.createElement("input");
      field.className = "dialog-input";
      field.dir = "auto";
      field.value = input;
      form.insertBefore(field, form.querySelector(".dialog-actions"));
    }
    const actions = wrap.querySelector(".dialog-actions");
    const close = (ok) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
      resolve(field ? (ok ? field.value.trim() : null) : ok);
    };
    const ok = button(okLabel, danger ? "danger" : "", () => {});
    ok.type = "submit";
    form.addEventListener("submit", (e) => { e.preventDefault(); close(true); });
    actions.append(ok);
    if (cancelLabel) actions.append(button(cancelLabel, "secondary", () => close(false)));
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(false); });
    document.body.append(wrap);
    (field || ok).focus();
  });
}
const notify = (message) => dialog(message);
const ask = (message, okLabel = t("yes"), opts = {}) => dialog(message, { okLabel, cancelLabel: t("cancel"), ...opts });
/** Ask for a short text; resolves with it, or null when cancelled. */
const askText = (message, value = "", okLabel = t("ok")) => dialog(message, { okLabel, cancelLabel: t("cancel"), input: value });

async function api(method, url, body, headers = { "Content-Type": "application/json" }) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : headers,
    body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showAuth();
    throw Object.assign(new Error(t("err.auth_required")), { status: 401, code: "auth_required" });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Server error ${res.status}`), { status: res.status, code: data.code });
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
    if (files.length) notify(t("onlyImages"));
    return;
  }
  let doc = state.doc;
  if (!doc) {
    try {
      const created = await api("POST", "/api/documents", { title: accepted[0].name.replace(/\.[^.]+$/, ""), writerId: defaultWriterId() });
      doc = adoptDoc(created, []);
    } catch (err) {
      return notify(t("createFailed", { msg: errText(err) }));
    }
    showDoc(doc);
  }
  for (const file of accepted) {
    try {
      const canvases = file.type === "application/pdf" ? await pdfToCanvases(file) : [await imageToCanvas(file)];
      for (const [i, canvas] of canvases.entries()) {
        const page = {
          id: crypto.randomUUID(),
          name: canvases.length > 1 ? t("pageOfFile", { file: file.name, n: i + 1 }) : file.name,
          canvas,
          status: "new",
          readRev: 0,
          lines: [],
        };
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        await api("PUT", `/api/documents/${doc.id}/pages/${page.id}/image`, blob, { "Content-Type": "image/jpeg" });
        page.src = pageImageUrl(doc, page);
        doc.pages.push(page);
        if (doc === state.doc) render();
        // The server must know the page before it can read it.
        await saveNow(doc);
        await requestRead(doc, page);
      }
    } catch (err) {
      console.error(err);
      notify(t("addFailed", { file: file.name, msg: errText(err) }));
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
  // isEvalSupported: false keeps a crafted PDF from running code (defence in depth).
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
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

const pageImageUrl = (doc, page) => `/api/documents/${doc.id}/pages/${page.id}/image`;

function adoptDoc(data, pages) {
  return { id: data.id, title: data.title, writerId: data.writerId || null, pages, timer: null, saving: false, dirty: false, failed: false };
}

function serialize(doc) {
  return {
    title: doc.title,
    writerId: doc.writerId,
    pages: doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      readRev: p.readRev || 0,
      lines: p.lines.map(({ text, ai, top, bottom, left, right, unclear }) => ({ text, ai, top, bottom, left, right, unclear })),
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

/** Save now and wait until no save is pending (or about ten seconds pass). */
async function saveNow(doc) {
  doc.dirty = true;
  for (let i = 0; i < 50 && hasUnsaved(doc); i++) {
    await flushSave(doc);
    if (hasUnsaved(doc)) await new Promise((r) => setTimeout(r, 200));
  }
}

function updateSaveState() {
  const el = $("#saveState");
  const doc = state.doc;
  if (!doc) return;
  el.classList.toggle("err", doc.failed);
  if (doc.failed) el.textContent = t("saveFailed");
  else if (hasUnsaved(doc)) el.textContent = t("saving");
  else el.textContent = t("saved");
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
    if (err.status !== 401) notify(t("openFailed", { msg: errText(err) }));
    return showHome();
  }
  const doc = adoptDoc(data, []);
  doc.pages = await Promise.all(
    data.pages.map(async (p) => {
      const page = { ...p, src: pageImageUrl(doc, p) };
      try {
        page.canvas = await loadCanvas(page.src);
        page.lines = withCrops(page, page.lines);
      } catch {
        page.canvas = null;
      }
      return page;
    })
  );
  if (location.hash !== `#doc=${id}`) return; // the user navigated away while loading
  showDoc(doc);
}

function showDoc(doc) {
  if (state.doc && state.doc !== doc) flushSave(state.doc);
  state.doc = doc;
  if (location.hash !== `#doc=${doc.id}`) history.pushState(null, "", `#doc=${doc.id}`);
  $("#upload").hidden = true;
  $("#writerView").hidden = true;
  $("#workspace").hidden = false;
  $("#docTitle").value = doc.title;
  renderWriterSelect();
  watchReading();
  document.title = `${doc.title || t("untitled")} — ${t("appName")}`;
  render();
  updateSaveState();
}

async function showHome() {
  if (state.doc) flushSave(state.doc);
  state.doc = null;
  if (location.hash) history.pushState(null, "", location.pathname);
  document.title = t("appName");
  $("#upload").hidden = false;
  $("#workspace").hidden = true;
  $("#writerView").hidden = true;
  $("#pages").innerHTML = "";
  await Promise.all([renderDocList(), renderWriterList()]);
}

async function renderDocList() {
  const list = $("#docList");
  let docs;
  try {
    docs = await api("GET", "/api/documents");
  } catch (err) {
    list.innerHTML = `<p class="save-state err">${escapeHtml(t("listFailed", { msg: errText(err) }))}</p>`;
    return;
  }
  list.innerHTML = "";
  if (!docs.length) return;
  list.insertAdjacentHTML("beforeend", `<h2>${escapeHtml(t("myDocs"))}</h2>`);
  for (const d of docs) {
    const item = document.createElement("div");
    item.className = "doc-item";
    const link = document.createElement("a");
    link.href = `#doc=${d.id}`;
    link.textContent = d.title || t("untitled");
    link.dir = "auto";
    const meta = document.createElement("span");
    meta.className = "meta";
    const when = new Date(d.updatedAt).toLocaleString(lang === "he" ? "he-IL" : "en-GB", { dateStyle: "short", timeStyle: "short" });
    meta.textContent = t("pagesUpdated", { n: d.pageCount, when });
    item.append(link, meta, button(t("delete"), "secondary", async () => {
      if (!(await ask(t("deleteDoc", { title: d.title || t("untitled") }), t("delete"), { danger: true }))) return;
      try {
        await api("DELETE", `/api/documents/${d.id}`);
      } catch (err) {
        notify(t("deleteFailed", { msg: errText(err) }));
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
  const writerId = location.hash.match(/^#writer=([A-Za-z0-9-]+)$/)?.[1];
  if (writerId) return showWriter(writerId);
  const id = location.hash.match(/^#doc=([A-Za-z0-9-]+)$/)?.[1];
  if (!id) return showHome();
  if (state.doc?.id !== id || $("#workspace").hidden) openDoc(id);
}
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

$("#backHome").addEventListener("click", showHome);
$("#docTitle").addEventListener("input", () => {
  if (!state.doc) return;
  state.doc.title = $("#docTitle").value;
  document.title = `${state.doc.title || t("untitled")} — ${t("appName")}`;
  scheduleSave(state.doc);
});

// ---------- Login ----------

let authMode = "login";
let signupNeedsCode = false;

function setAuthMode(mode) {
  authMode = mode;
  const register = mode === "register";
  $("#authTitle").textContent = t(register ? "register" : "login");
  $("#authSubmit").textContent = t(register ? "createAccount" : "login");
  $("#authSwitchText").textContent = t(register ? "haveAccount" : "noAccount");
  $("#authSwitch").textContent = t(register ? "login" : "register");
  $("#authPass").autocomplete = register ? "new-password" : "current-password";
  $("#authCodeRow").hidden = !(register && signupNeedsCode);
  $("#authShareRow").hidden = !register;
  $("#authError").textContent = "";
}

function showAuth() {
  $("#accountName").hidden = true;
  $("#logout").hidden = true;
  state.user = null;
  state.doc = null;
  state.writers = [];
  $("#upload").hidden = true;
  $("#workspace").hidden = true;
  $("#writerView").hidden = true;
  $("#pages").innerHTML = "";
  $("#docList").innerHTML = "";
  $("#auth").hidden = false;
  $("#authUser").focus();
}

function signedIn(user) {
  state.user = user;
  $("#auth").hidden = true;
  $("#accountName").hidden = false;
  $("#accountName").textContent = user.username || t("myAccount");
  $("#logout").hidden = false;
  $("#shareSetting").checked = Boolean(user.shareForTraining);
  $("#authPass").value = "";
  $("#authCode").value = "";
  loadWriters().finally(route);
}

$("#shareSetting").addEventListener("change", async () => {
  try {
    const data = await api("PATCH", "/api/auth/me", { shareForTraining: $("#shareSetting").checked });
    state.user = data.user;
  } catch (err) {
    $("#shareSetting").checked = !$("#shareSetting").checked;
    notify(errText(err));
  }
});

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
    if (authMode === "register") {
      body.code = $("#authCode").value;
      body.shareForTraining = $("#authShare").checked;
    }
    const data = await api("POST", `/api/auth/${authMode}`, body);
    signedIn(data.user);
  } catch (err) {
    $("#authError").textContent = errText(err);
  } finally {
    submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  const doc = state.doc;
  if (doc && hasUnsaved(doc)) {
    await flushSave(doc);
    if (hasUnsaved(doc) && !(await ask(t("logoutUnsaved"), t("logout")))) return;
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
    notify(t("serverDown", { msg: errText(err) }));
  }
}

// ---------- Reading (done by the server) ----------

/** Ask the server to read a page; it keeps going even if this tab closes. */
async function requestRead(doc, page) {
  try {
    await api("POST", `/api/documents/${doc.id}/pages/${page.id}/read`, {});
    page.status = "queued";
    page.error = null;
  } catch (err) {
    page.status = "error";
    page.error = errText(err);
  }
  if (doc === state.doc) {
    renderPage(page);
    updateStatus();
    watchReading();
  }
}

const isBusy = (p) => p.status === "queued" || p.status === "working";
let pollTimer = null;

/** While pages are being read, check the server for progress and results. */
function watchReading() {
  clearTimeout(pollTimer);
  if (!state.doc?.pages.some(isBusy)) return;
  const doc = state.doc;
  pollTimer = setTimeout(async () => {
    if (doc !== state.doc) return;
    try {
      const fresh = await api("GET", `/api/documents/${doc.id}`);
      if (doc !== state.doc) return;
      const byId = new Map(fresh.pages.map((p) => [p.id, p]));
      for (const page of doc.pages) {
        const server = byId.get(page.id);
        if (!server) continue;
        const newer = (server.readRev || 0) > (page.readRev || 0);
        const changed = newer || server.status !== page.status || JSON.stringify(server.progress) !== JSON.stringify(page.progress);
        Object.assign(page, { status: server.status, progress: server.progress, error: server.error, errorCode: server.errorCode, readBy: server.readBy });
        if (newer) {
          page.readRev = server.readRev;
          page.lines = withCrops(page, server.lines);
        }
        if (changed) renderPage(page);
      }
      updateStatus();
    } catch (err) {
      console.error(err);
    }
    watchReading();
  }, POLL_MS);
}

/** Add the handwriting image of each line, cut from the page. */
function withCrops(page, lines) {
  if (!page.canvas) return lines;
  return lines.map((l) => (l.top == null ? l : { ...l, ...cropLine(page.canvas, l) }));
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
    container.innerHTML = `<div class="page empty">${escapeHtml(t("noPagesYet"))}</div>`;
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

  if (page.src) head.append(button(t("viewPage"), "secondary", () => openLightbox(page)));

  if (page.status === "new") st.textContent = t("notRead");
  if (page.status === "queued") st.textContent = t("queued");
  if (page.status === "working") {
    const step = page.progress?.step || 0;
    const label = step ? t("readStep", { step, of: page.progress.of, what: t(`step${step}`) }) : t("reading");
    st.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`;
  }
  if (page.status === "error") {
    st.classList.add("err");
    st.textContent = t("errorPrefix", { msg: errText({ code: page.errorCode, message: page.error }) });
  }
  if (page.status === "done") {
    const n = page.lines.filter((l) => l.unclear.length).length;
    st.textContent = t("linesCount", { n: page.lines.length }) + (n ? ` · ${t("toCheck", { n })}` : "")
      + (page.readBy ? ` · ${t(`readBy_${page.readBy}`)}` : "");
  }
  if (!isBusy(page) && page.canvas) {
    head.append(button(page.status === "new" ? t("read") : t("reread"), "secondary", async () => {
      if (page.status === "done" && !(await ask(t("rereadConfirm"), t("reread")))) return;
      const doc = state.doc;
      await flushSave(doc);
      await requestRead(doc, page);
    }));
  }
  head.append(button(t("remove"), "secondary", async () => {
    if (page.status === "done" && !(await ask(t("removeConfirm"), t("remove"), { danger: true }))) return;
    state.doc.pages = state.doc.pages.filter((p) => p !== page);
    scheduleSave(state.doc);
    render();
  }));
  el.append(head);

  if (page.status !== "done") return;
  if (!page.lines.length) {
    el.insertAdjacentHTML("beforeend", `<div class="empty">${escapeHtml(t("noHandwriting"))}</div>`);
    return;
  }
  if (state.view === "lines") renderLines(page, el);
  else renderDoc(page, el);
}

function renderLines(page, el) {
  el.insertAdjacentHTML("beforeend", `<div class="col-head"><div>${escapeHtml(t("colHandwriting"))}</div><div>${escapeHtml(t("colText"))}</div></div>`);
  page.lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "row" + (line.unclear.length ? " unclear" : "");

    if (line.crop) {
      const img = document.createElement("img");
      img.className = "crop";
      img.src = line.crop;
      img.alt = t("lineAlt", { n: i + 1 });
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
      flag.append(t("checkWords", { words: line.unclear.join(", ") }));
      flag.append(button(t("checked"), "", () => {
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
      m.title = t("pleaseCheck");
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
  const working = pages.filter(isBusy).length;
  const errors = pages.filter((p) => p.status === "error").length;
  let text = t("pagesReady", { done, total });
  if (working) text += ` · ${t("working")}`;
  if (errors) text += ` · ${t("errorsCount", { n: errors })}`;
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
    notify(t("downloadFailed", { msg: errText(err) }));
  }
});

$("#copyAll").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(plainText());
  } catch {
    return notify(t("copyFailed"));
  }
  $("#copyAll").textContent = t("copied");
  setTimeout(() => ($("#copyAll").textContent = t("copy")), 1500);
});

async function exportDocx(withImages, btn) {
  const done = donePages();
  const pages = done.map((p, i) => ({
    heading: done.length > 1 ? t("pageHeading", { n: i + 1 }) : undefined,
    lines: p.lines.map((l) => ({
      text: finalText(l.text),
      ...(withImages && l.crop ? { image: l.crop, width: l.cropW, height: l.cropH } : {}),
    })),
  }));
  if (!pages.length) return notify(t("nothingToExport"));
  btn.disabled = true;
  try {
    const blob = await api("POST", "/api/export/docx", { pages, withImages });
    await download(blob, withImages ? "transcription-with-handwriting.docx" : "transcription.docx");
  } catch (err) {
    if (err.status !== 401) notify(t("exportFailed", { msg: errText(err) }));
  } finally {
    btn.disabled = false;
  }
}
$("#exportDocx").addEventListener("click", (e) => exportDocx(false, e.currentTarget));
$("#exportDocxImages").addEventListener("click", (e) => exportDocx(true, e.currentTarget));

// Leaving the page: start any pending save now, and warn while one is still in flight.
// (Reading carries on at the server, so it needs no warning.)
window.addEventListener("beforeunload", (e) => {
  const doc = state.doc;
  if (!doc) return;
  if (doc.dirty && !doc.saving) flushSave(doc);
  if (hasUnsaved(doc)) e.preventDefault();
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".row textarea").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  });
});

// ---------- Handwriting profiles ----------

async function loadWriters() {
  try {
    state.writers = await api("GET", "/api/writers");
  } catch (err) {
    console.error(err);
  }
}

const writerName = (w) => w?.name || t("untitledWriter");

/** The writer for a new document: the one used last, else the first. */
function defaultWriterId() {
  let last = null;
  try { last = localStorage.getItem("hw_writer"); } catch {}
  return (state.writers.find((w) => w.id === last) || state.writers[0])?.id || null;
}

function rememberWriter(id) {
  try { localStorage.setItem("hw_writer", id); } catch {}
}

async function newWriter() {
  const name = await askText(t("newWriterPrompt"), "", t("create"));
  if (!name) return null;
  try {
    const writer = await api("POST", "/api/writers", { name });
    await loadWriters();
    return writer;
  } catch (err) {
    notify(errText(err));
    return null;
  }
}

function renderWriterSelect() {
  const select = $("#writerSelect");
  const doc = state.doc;
  if (!doc) return;
  select.innerHTML = "";
  for (const w of state.writers) select.add(new Option(writerName(w), w.id));
  select.add(new Option(t("noWriter"), ""));
  select.add(new Option(t("newWriterOption"), "__new"));
  select.value = state.writers.some((w) => w.id === doc.writerId) ? doc.writerId : "";
}

$("#writerSelect").addEventListener("change", async () => {
  const doc = state.doc;
  if (!doc) return;
  let id = $("#writerSelect").value;
  if (id === "__new") id = (await newWriter())?.id ?? doc.writerId ?? "";
  doc.writerId = id || null;
  if (id) rememberWriter(id);
  renderWriterSelect();
  scheduleSave(doc);
});

async function renderWriterList() {
  const list = $("#writerList");
  await loadWriters();
  list.innerHTML = "";
  const head = document.createElement("div");
  head.className = "list-head";
  head.innerHTML = `<h2>${escapeHtml(t("profiles"))}</h2>`;
  head.append(button(t("newWriter"), "secondary", async () => { if (await newWriter()) renderWriterList(); }));
  list.append(head);
  const note = document.createElement("p");
  note.className = "list-note";
  note.textContent = t("profilesNote");
  list.append(note);
  for (const w of state.writers) {
    const item = document.createElement("div");
    item.className = "doc-item";
    const link = document.createElement("a");
    link.href = `#writer=${w.id}`;
    link.textContent = writerName(w);
    link.dir = "auto";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = t("learnedCount", { n: w.correctedCount ?? w.exampleCount }) + (w.model ? ` · ${t("personalModel")}` : "") + (w.learn ? "" : ` · ${t("learningOff")}`);
    item.append(link, meta);
    list.append(item);
  }
}

async function showWriter(writerId) {
  if (state.doc) flushSave(state.doc);
  state.doc = null;
  await loadWriters();
  const writer = state.writers.find((w) => w.id === writerId);
  if (!writer) return showHome();
  let examples = [];
  try {
    examples = await api("GET", `/api/writers/${writerId}/examples`);
  } catch (err) {
    notify(errText(err));
  }
  $("#upload").hidden = true;
  $("#workspace").hidden = true;
  $("#writerView").hidden = false;
  document.title = `${writerName(writer)} — ${t("appName")}`;
  $("#writerName").textContent = writerName(writer);
  $("#writerLearn").checked = writer.learn;
  $("#writerSummary").textContent = t("writerSummary", { n: examples.length });
  $("#writerView").dataset.id = writerId;
  renderTraining(writer);

  const list = $("#exampleList");
  list.innerHTML = "";
  if (!examples.length) list.innerHTML = `<p class="list-note">${escapeHtml(t("noExamples"))}</p>`;
  for (const e of examples) {
    const row = document.createElement("div");
    row.className = "example";
    const img = document.createElement("img");
    img.className = "crop";
    img.loading = "lazy";
    img.src = `/api/writers/${writerId}/examples/${e.id}/image`;
    img.alt = e.text;
    const text = document.createElement("div");
    text.className = "example-text";
    const right = document.createElement("div");
    right.dir = "rtl";
    right.lang = "he";
    right.textContent = e.text;
    const was = document.createElement("div");
    was.className = "example-was";
    was.append(`${t("misreadAs")} `);
    const wasText = document.createElement("span");
    wasText.dir = "rtl";
    wasText.lang = "he";
    wasText.textContent = e.ai;
    was.append(wasText);
    text.append(right, was);
    row.append(img, text, button(t("forget"), "secondary", async () => {
      await api("DELETE", `/api/writers/${writerId}/examples/${e.id}`).catch((err) => notify(errText(err)));
      showWriter(writerId);
    }));
    list.append(row);
  }
}

const pct = (cer) => (cer == null ? "?" : (Math.round(cer * 1000) / 10).toString());
let trainTimer = null;

/** The personal-model panel: what is in use, what training is doing, and the button. */
function renderTraining(writer) {
  clearTimeout(trainTimer);
  const tr = writer.training || {};
  const busy = tr.status === "queued" || tr.status === "running";
  const when = (iso) => new Date(iso).toLocaleString(lang === "he" ? "he-IL" : "en-GB", { dateStyle: "short", timeStyle: "short" });

  let status = writer.model ? t("trainInUse", { when: when(writer.model.trainedAt), lines: writer.model.lines }) : t("trainNoModel");
  if (tr.status === "queued") status = t("trainQueued");
  if (tr.status === "running") {
    status = t("trainRunning", { lines: tr.lines, pct: tr.of ? Math.round((100 * tr.step) / tr.of) : 0 });
  }
  $("#trainStatus").textContent = status;

  let result = "";
  if (tr.status === "done" && tr.kept && tr.held) result = t("trainGain", { held: tr.held, before: pct(tr.before), after: pct(tr.after) });
  else if (writer.model?.before != null && !busy) result = t("trainGain", { held: tr.held || "?", before: pct(writer.model.before), after: pct(writer.model.after) });
  const m = writer.model;
  if (m?.compared >= 5 && !busy) {
    result += " " + t(m.beatsGemini ? "beatsGemini" : "behindGemini", { n: m.compared, gemini: pct(m.gemini), personal: pct(m.personalOnGemini) });
  }
  if (tr.status === "done" && !tr.kept && tr.reason === "no_gain") result = t("trainNoGain");
  if (tr.status === "failed") result = tr.error === "interrupted" ? t("trainInterrupted") : t("trainFailed", { msg: tr.error || "" });
  $("#trainResult").textContent = result;

  const bar = $("#trainBar");
  bar.hidden = !busy;
  bar.firstElementChild.style.width = tr.status === "running" && tr.of ? `${(100 * tr.step) / tr.of}%` : "0";

  const button = $("#trainButton");
  button.hidden = busy;
  button.disabled = !writer.canTrain;
  button.textContent = writer.model ? t("trainAgain") : t("trainButton");
  $("#trainAuto").textContent = writer.canTrain ? t("trainAuto", { n: 25 }) : t("trainNeedMore", { min: writer.trainMin, n: writer.exampleCount });

  if (busy) {
    trainTimer = setTimeout(async () => {
      if ($("#writerView").hidden || $("#writerView").dataset.id !== writer.id) return;
      await loadWriters();
      const fresh = state.writers.find((w) => w.id === writer.id);
      if (fresh) renderTraining(fresh);
    }, 4000);
  }
}

$("#trainButton").addEventListener("click", async () => {
  const id = $("#writerView").dataset.id;
  try {
    await api("POST", `/api/writers/${id}/train`, {});
  } catch (err) {
    return notify(errText(err));
  }
  await loadWriters();
  const writer = state.writers.find((w) => w.id === id);
  if (writer) renderTraining(writer);
});

$("#writerBack").addEventListener("click", showHome);
$("#writerLearn").addEventListener("change", async () => {
  const id = $("#writerView").dataset.id;
  await api("PATCH", `/api/writers/${id}`, { learn: $("#writerLearn").checked }).catch((err) => notify(errText(err)));
  await loadWriters();
});
$("#writerRename").addEventListener("click", async () => {
  const id = $("#writerView").dataset.id;
  const writer = state.writers.find((w) => w.id === id);
  const name = await askText(t("renameWriterPrompt"), writer?.name || "", t("save"));
  if (!name) return;
  await api("PATCH", `/api/writers/${id}`, { name }).catch((err) => notify(errText(err)));
  showWriter(id);
});
$("#writerDelete").addEventListener("click", async () => {
  const id = $("#writerView").dataset.id;
  const writer = state.writers.find((w) => w.id === id);
  if (!(await ask(t("deleteWriterConfirm", { name: writerName(writer) }), t("delete"), { danger: true }))) return;
  await api("DELETE", `/api/writers/${id}`).catch((err) => notify(errText(err)));
  showHome();
});

// ---------- Interface language ----------

$("#langSwitch").addEventListener("click", () => {
  setLanguage(lang === "en" ? "he" : "en");
  setAuthMode(authMode);
  if (state.doc) {
    document.title = `${state.doc.title || t("untitled")} — ${t("appName")}`;
    render();
    updateSaveState();
    renderWriterSelect();
  } else {
    document.title = t("appName");
    if (state.user) route();
  }
  if (state.user) $("#accountName").textContent = state.user.username || t("myAccount");
});

applyLanguage();
start();
