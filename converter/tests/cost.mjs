// Cost of reading one page: every Gemini request a full reading sends (line reading, word check,
// word choices for the highlighted words), counted in tokens and priced. A 25-line page.
// Usage: node cost.mjs WORK_DIR FILE [maxCents]
import { start, tagCrops, installFake, corruptLines, allReady, TRUTH } from "./harness.mjs";
import fs from "node:fs";
const [S, FILE, MAX] = process.argv.slice(2);
fs.mkdirSync(`${S}/e2e`, { recursive: true });
// Price per million tokens: input, output (thinking counts as output). Gemini Flash, Nov 2026.
const IN = 0.75, OUT = 3.75;
const IMG = { MEDIA_RESOLUTION_LOW: 280, MEDIA_RESOLUTION_MEDIUM: 560, MEDIA_RESOLUTION_HIGH: 1120, undefined: 1120 };
const THINK = { LOW: 400, MEDIUM: 1500, HIGH: 4000 }; // thinking tokens per request (an estimate, generous)
const { browser, page, errors } = await start(FILE);
const LINES = Array.from({ length: 25 }, (_, i) => TRUTH[1 + (i % 5)]);
const truth = await page.evaluate((lines) => {
  const W = 2000, H = 2800, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#123"; x.font = "52px DejaVu Sans, Arial, sans-serif"; x.direction = "rtl"; x.textAlign = "right";
  const out = [];
  lines.forEach((text, li) => {
    const base = 130 + li * 105, top = base - 62, bottom = base + 20; let right = 1900; const words = [];
    for (const w of text.split(" ")) { const width = x.measureText(w).width; x.fillText(w, right, base); words.push({ text: w, left: ((right - width) / W) * 1000, right: (right / W) * 1000 }); right -= width + 55; }
    out.push({ text, top: (top / H) * 1000, bottom: (bottom / H) * 1000, left: ((right + 30) / W) * 1000, right: (1930 / W) * 1000, words });
  });
  window.__png = c.toDataURL("image/png"); return out;
}, LINES);
fs.writeFileSync(`${S}/e2e/cost.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
await tagCrops(page);
// Each request with when it was sent and when it was answered: Google bills the beginning a request
// shares with one it already answered (instructions, the writer's examples) at a tenth.
const bodies = [], sent = new Map();
page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("generativelanguage")) { const b = r.postDataJSON(); b.sentAt = Date.now(); sent.set(r, b); bodies.push(b); } });
page.on("requestfinished", (r) => { const b = sent.get(r); if (b) b.doneAt = Date.now(); });
const stats = await installFake(page, truth, { lineText: corruptLines });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/cost.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
await page.waitForTimeout(1500);
function price(bodies) {
  let tin = 0, tout = 0, images = 0, imgTok = 0, textTok = 0, cachedTok = 0;
  const toks = (s) => Math.ceil(s.length / 2.5); // Hebrew-heavy text: about 2.5 characters a token
  const partTok = (b, p) => (p.inlineData ? IMG[p.mediaResolution?.level ?? b.generationConfig?.mediaResolution] : p.text ? toks(p.text) : 0);
  // The beginning two requests share: the instructions, then their parts as long as they're the same.
  const shared = (a, b) => {
    if (JSON.stringify(a.systemInstruction) !== JSON.stringify(b.systemInstruction)) return 0;
    let t = a.systemInstruction.parts.reduce((s, p) => s + partTok(a, p), 0);
    const pa = a.contents[0].parts, pb = b.contents[0].parts;
    for (let i = 0; i < Math.min(pa.length, pb.length) && JSON.stringify(pa[i]) === JSON.stringify(pb[i]); i++) t += partTok(a, pa[i]);
    return t;
  };
  for (const b of bodies) {
    const parts = [...b.systemInstruction.parts, ...b.contents[0].parts];
    for (const p of parts) {
      if (p.inlineData) { images++; const t = partTok(b, p); imgTok += t; tin += t; }
      if (p.text) { const t = toks(p.text); textTok += t; tin += t; }
    }
    // Google caches a beginning of at least 1024 tokens; only requests sent after it was answered get it.
    const c = Math.max(0, ...bodies.filter((o) => o !== b && o.doneAt && o.doneAt <= b.sentAt).map((o) => shared(o, b)));
    if (c >= 1024) cachedTok += c;
    const t = toks(JSON.stringify(b.generationConfig.responseJsonSchema)); tin += t; textTok += t;
    tout += 150 + (THINK[b.generationConfig.thinkingConfig?.thinkingLevel] || 0);
  }
  const cents = ((tin - cachedTok * 0.9) * IN + tout * OUT) / 1e6 * 100;
  return { requests: bodies.length, images, imageTokens: imgTok, textTokens: textTok, inputTokens: tin, cachedTokens: cachedTok, outputTokens: tout, cents: +cents.toFixed(2) };
}
const first = price(bodies.splice(0));
const label = await page.locator(".page-head .state").first().textContent();
const meterOk = /cost about \d+(\.\d)?¢/.test(label);
console.log((meterOk ? "PASS" : "FAIL") + " the page shows what it cost  " + label);
console.log("new writer:", JSON.stringify(first));
// A writer with many corrections: as many example lines and words as are ever kept, and misread words.
await page.evaluate(async () => {
  const [w] = await getAll("writers");
  const blob = (wd, ht) => { const c = document.createElement("canvas"); c.width = wd; c.height = ht; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, wd, ht); g.fillStyle = "#000"; g.font = "60px sans-serif"; g.fillText("שלום עולם", 20, 200); return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9)); };
  w.examples = []; w.wordExamples = [];
  for (let i = 0; i < 60; i++) w.examples.push({ pageId: "old" + i, text: "שלום לכולם היום נלמד " + i, ai: "שלום לכולם היום למד " + i, crop: await blob(2400, 320) });
  for (let i = 0; i < 40; i++) w.wordExamples.push({ text: "מילה" + i, misread: "מלה" + i, crop: await blob(400, 240) });
  w.memory = { fixes: Object.fromEntries(Array.from({ length: 150 }, (_, i) => ["טעות" + i, { to: "תיקון" + i, count: 2 }])) };
  await putOne("writers", w);
});
await page.setInputFiles("#fileInput", `${S}/e2e/cost.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 2);
await allReady(page, stats, 2);
await page.waitForTimeout(1500);
const second = price(bodies.splice(0));
console.log("writer with many corrections:", JSON.stringify(second));
const cents = Math.max(first.cents, second.cents);
const ok = meterOk && errors.length === 0 && (!MAX || cents <= +MAX);
console.log((ok ? "PASS" : "FAIL") + ` a 25-line page costs about ${first.cents.toFixed(1)}¢ (new writer), ${second.cents.toFixed(1)}¢ (writer with many corrections)${MAX ? `; limit ${MAX}¢` : ""}` + (errors.length ? "  " + errors.join("\n") : ""));
await browser.close();
process.exit(ok ? 0 : 1);
