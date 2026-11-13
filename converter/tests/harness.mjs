// End-to-end tests for hebrew-converter.html with a fake Gemini that knows which
// word each picture holds. Run all:  sh converter/tests/run.sh
// A fake Gemini that knows which word each picture holds (via a hidden code painted on each picture during the test).
// Playwright: set PLAYWRIGHT to its index.mjs if it isn't installed in this project.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { createRequire } from "node:module";
const sharp = createRequire(new URL("../../package.json", import.meta.url))("sharp");
import fs from "node:fs";

export const TRUTH = [
  "בס״ד",
  "שלום לכולם, היום נלמד על ההיסטוריה של העיר.",
  "העיר נוסדה לפני יותר ממאה שנה (בערך).",
  "באשתו וחייב במזנותיה כאילו היגיע זמן דבלא זה",
  "הקנס אינו מובן: דצורת הקנס היא ד״ר ת״ת.",
  "ומה שאמר ר׳ יוחנן - קשה לי לומר!",
];

export async function launch() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, acceptDownloads: true });
  return { browser, ctx };
}

/** Draw the test page in the browser; returns the PNG path and the true words with their boxes (0-1000). */
export async function makePage(page, path) {
  const res = await page.evaluate((lines) => {
    const W = 2000, H = 1500, c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#123"; x.font = "56px DejaVu Sans, Arial, sans-serif"; x.direction = "rtl"; x.textAlign = "right"; x.textBaseline = "alphabetic";
    const out = [];
    lines.forEach((text, li) => {
      const base = 170 + li * 210, top = base - 70, bottom = base + 25;
      let right = 1900; const words = [];
      for (const w of text.split(" ")) {
        const width = x.measureText(w).width;
        x.fillText(w, right, base);
        words.push({ text: w, left: ((right - width) / W) * 1000, right: (right / W) * 1000 });
        right -= width + 60;
      }
      out.push({ text, top: (top / H) * 1000, bottom: (bottom / H) * 1000, left: ((right + 30) / W) * 1000, right: (1930 / W) * 1000, words });
    });
    return { url: c.toDataURL("image/png"), lines: out };
  }, TRUTH);
  fs.writeFileSync(path, Buffer.from(res.url.split(",")[1], "base64"));
  return res.lines;
}

/** Paint a code onto every picture the converter cuts, and remember which box it was. */
export async function tagCrops(page) {
  await page.evaluate(() => {
    window.__boxes = [];
    const orig = window.cropLine;
    window.cropLine = function (bitmap, box, height) {
      const inner = orig(bitmap, box, height);
      const c = document.createElement("canvas");
      c.width = Math.max(inner.width, 36); c.height = Math.max(inner.height, 24);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(inner, 0, 0);
      const id = window.__boxes.push({ ...box }) - 1;
      for (let k = 0; k < 10; k++) { g.fillStyle = (id >> k) & 1 ? "#000" : "#fff"; g.fillRect((k % 5) * 6, Math.floor(k / 5) * 6, 6, 6); }
      g.fillStyle = "#f00"; g.fillRect(30, 0, 6, 12);
      return c;
    };
  });
}

export async function readTag(b64) {
  const { data, info } = await sharp(Buffer.from(b64, "base64")).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const [r, g, b] = px(33, 5);
  if (!(r > 150 && g < 100 && b < 100)) return -1;
  let id = 0;
  for (let k = 0; k < 10; k++) { const [v] = px((k % 5) * 6 + 3, Math.floor(k / 5) * 6 + 3); if (v < 128) id |= 1 << k; }
  return id;
}

/** The true line a box is on. */
export function lineOf(truth, box) {
  const mid = (box.top + box.bottom) / 2;
  let line = null, best = Infinity;
  for (const l of truth) { const d = Math.abs((l.top + l.bottom) / 2 - mid); if (d < best) { best = d; line = l; } }
  return line;
}
/** Which true words a box covers (by overlap), in reading order. */
export function wordsIn(truth, box) {
  const line = lineOf(truth, box);
  if (!line) return [];
  return line.words.filter((w) => {
    const ov = Math.min(w.right, box.right) - Math.max(w.left, box.left);
    return ov > (w.right - w.left) * 0.5;
  }).map((w) => w.text);
}

export function sse(data) {
  const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "…", thought: true }, { text: JSON.stringify(data) }] }, finishReason: "STOP" }] };
  return { status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: `data: ${JSON.stringify(chunk)}\r\n\r\n` };
}

/**
 * Install the fake Gemini. opts: delay (ms per request), pageText(fake, truth) to corrupt the
 * page reading, emptyWord (a word answered with ""), fail(kind, n) -> {status, message} to fail
 * the n-th request of a kind ("page" | "words" | "lines" | "pick").
 */
export async function installFake(page, truth, opts = {}) {
  const stats = { page: 0, words: 0, lines: 0, pick: 0, options: 0, wordImages: 0, models: [] };
  const err = (status, message) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ error: { code: status, message } }) });
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ models: (opts.models || ["gemini-flash-latest"]).map((n) => ({ name: "models/" + n, supportedGenerationMethods: ["generateContent"] })) }) });
    const url = route.request().url();
    stats.models.push(url.split("/models/")[1].split(":")[0]);
    const body = route.request().postDataJSON();
    const parts = body.contents[0].parts;
    const raw = JSON.stringify(parts.filter((p) => p.text));
    const kind = raw.includes("readings that its pen strokes most look like") ? "options" : /ONE handwritten (Hebrew )?word/.test(raw) ? "words" : raw.includes("candidate spellings") ? "pick" : raw.includes("each one handwritten line cut out of a page") ? "lines" : "page";
    const n = ++stats[kind];
    (stats.raw ||= []).push({ kind, raw });
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (opts.delayFor) { const d = opts.delayFor(kind, n); if (d === Infinity) return; await new Promise((r) => setTimeout(r, d)); } // Infinity: never answers
    const f = opts.fail?.(kind, n, url);
    if (f) return route.fulfill(err(f.status, f.message));
    const boxes = await page.evaluate(() => window.__boxes).catch(() => null);
    if (!boxes) return route.abort().catch(() => {});
    const numbered = [];
    parts.forEach((p, i) => { const m = p.text?.match(/^Image (\d+)/); if (m && parts[i + 1]?.inlineData) numbered.push({ n: +m[1], data: parts[i + 1].inlineData.data }); });
    const boxOf = async (data) => { const id = await readTag(data); if (id < 0 || !boxes[id]) throw new Error("unreadable test tag"); return boxes[id]; };
    if (kind === "words") {
      stats.wordImages += numbered.length;
      const words = [];
      for (const { n: k, data } of numbered) {
        let text = wordsIn(truth, await boxOf(data)).join(" ");
        if (opts.emptyWord && text === opts.emptyWord) text = "";
        if (opts.wordText) text = opts.wordText(text);
        words.push({ image: k, text, sure: true });
      }
      return route.fulfill(sse({ words }));
    }
    if (kind === "options") {
      const words = [];
      for (const { n: k, data } of numbered) { const w = wordsIn(truth, await boxOf(data)).join(" "); words.push({ image: k, options: opts.optionsFor?.(w) || [w, w + "ה", "ו" + w] }); }
      return route.fulfill(sse({ words }));
    }
    if (kind === "pick") return route.fulfill(sse({ answers: numbered.map(({ n: k }) => ({ image: k, choice: "none" })) }));
    if (kind === "lines") {
      const lines = [];
      for (const { n: k, data } of numbered) {
        const box = await boxOf(data);
        let text = wordsIn(truth, { ...box, left: 0, right: 1000 }).join(" ");
        if (opts.lineText) text = opts.lineText(text, n);
        const dir = lineOf(truth, box)?.dir;
        lines.push({ image: k, text, unclear: [], ...(dir ? { direction: dir } : {}) });
      }
      return route.fulfill(sse({ lines }));
    }
    let fake = truth.map((l) => ({ text: l.text, top: Math.round(l.top), bottom: Math.round(l.bottom), left: Math.round(l.left), right: Math.round(l.right), unclear: [] }));
    if (opts.pageText) fake = opts.pageText(fake, truth) || fake;
    return route.fulfill(sse({ lines: fake }));
  });
  return stats;
}

export const corrupt = (fake, truth) => {
  fake[1].text = "שלום לכולם היום נלמד על ההיסטוריה של העיר.";
  fake[3].text = "כשנאנס וחייב בתשלומי׳ כאילו הגיע זמן דאז של זה";
  fake[4].left = Math.round(truth[4].words.at(-1).right + 3);
  return fake;
};

export async function start(FILE, { writer = "Tester" } = {}) {
  const { browser, ctx } = await launch();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.stack));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("file://" + FILE);
  return { browser, ctx, page, errors };
}

export function checker() {
  let ok = true;
  const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); ok &&= !!cond; };
  return { check, done: () => ok };
}

export const dbDump = (page) => page.evaluate(async () => ({ docs: await getAll("docs"), writers: (await getAll("writers")).map((w) => ({ ...w, examples: (w.examples || []).map((e) => ({ ...e, crop: !!e.crop })) })) }));

/** Made-up words in the line reading (the word-by-word check must catch them). */
export const corruptLines = (text) => {
  if (text.startsWith("באשתו")) return "כשנאנס וחייב בתשלומי׳ כאילו הגיע זמן דאז של זה";
  if (text.startsWith("שלום")) return text.replace("לכולם,", "לכולם");
  return text;
};

/** Wait until every page is read and its word check has finished. */
export const settled = (page, n = 1, timeout = 180000) => page.waitForFunction((n) => {
  const s = [...document.querySelectorAll(".page-head .state")];
  return s.length >= n && s.filter((x) => /\d+ lines/.test(x.textContent) && !/checking|getting word options/.test(x.textContent)).length >= n;
}, n, { timeout });

/** The words a line highlights, and the choices its menu offers for one word. */
export const marksOf = (page, i) => page.locator(".row").nth(i).locator(".line-edit mark").allTextContents();
export async function choicesOf(page, i, word) {
  await page.locator(".row").nth(i).locator(".line-edit mark", { hasText: word }).first().click();
  await page.waitForSelector(".popover");
  const c = await page.locator(".popover button").allTextContents();
  await page.keyboard.press("Escape");
  return c;
}

/** Wait until the page is read, checked, and its word choices are ready (they come last, automatically). */
export async function allReady(page, stats, n = 1) {
  await settled(page, n);
  const t0 = Date.now();
  while (stats.options < n && Date.now() - t0 < 60000) await page.waitForTimeout(200);
  await settled(page, n);
}
