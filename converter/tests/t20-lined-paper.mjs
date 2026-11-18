// On lined paper (the printed line runs through every word, so the line seems one piece of ink),
// a clicked word is still outlined where it is in the handwriting, not the whole line.
import { start, tagCrops, installFake, allReady, checker } from "./harness.mjs";
import fs from "node:fs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const TEXT = ["שלום לכולם היום נלמד על ההיסטוריה של העיר"];
const truth = await page.evaluate((lines) => {
  const W = 2000, H = 500, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.strokeStyle = "#88a"; x.lineWidth = 4; x.beginPath(); x.moveTo(0, 262); x.lineTo(W, 262); x.stroke(); // the paper's printed line
  x.fillStyle = "#123"; x.font = "64px DejaVu Sans"; x.direction = "rtl"; x.textAlign = "right";
  const out = [];
  lines.forEach((text) => {
    const base = 250, top = base - 75, bottom = base + 25; let right = 1900; const words = [];
    for (const w of text.split(" ")) { const width = x.measureText(w).width; x.fillText(w, right, base); words.push({ text: w, left: (right - width) / W * 1000, right: right / W * 1000 }); right -= width + 60; }
    out.push({ text, top: top / H * 1000, bottom: bottom / H * 1000, left: (right + 30) / W * 1000, right: 1930 / W * 1000, words });
  });
  window.__png = c.toDataURL("image/png");
  return out;
}, TEXT);
fs.writeFileSync(`${S}/e2e/lined.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
await tagCrops(page);
const stats = await installFake(page, truth);
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/lined.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const ed = page.locator(".row .line-edit").first();
const pieces = await page.evaluate(async () => { const p = state.doc.pages[0]; return segmentWords(await pageBitmap(p), p.lines[0])?.length; });
check("(the printed line joins the words: far fewer pieces than words)", pieces < 4, `pieces ${pieces}`);
const outlined = async (n) => {
  await ed.evaluate((el, n) => {
    const text = el.innerText; let i = -1, start = 0;
    for (const m of text.matchAll(/\S+/g)) if (++i === n) { start = m.index + 1; break; }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0, node, off = 0;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) { if (start <= pos + t.textContent.length) { node = t; off = start - pos; break; } pos += t.textContent.length; }
    el.focus(); const r = document.createRange(); r.setStart(node, off); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, n);
  await ed.dispatchEvent("keyup");
  await page.waitForTimeout(500);
  return page.locator(".word-box").first().evaluate((b) => (b.hidden ? null : { right: parseFloat(b.style.right), width: parseFloat(b.style.width) }));
};
const pic = truth[0], W = 2000, h = (pic.bottom - pic.top) / 1000 * 500, x0 = pic.left / 1000 * W - h * 0.05, x1 = pic.right / 1000 * W + h * 0.05;
for (const n of [1, 4, 6]) {
  const spot = await outlined(n), w = pic.words[n];
  const trueRight = 100 * (1 - (w.right / 1000 * W - x0) / (x1 - x0)), trueWidth = 100 * ((w.right - w.left) / 1000 * W) / (x1 - x0);
  check(`word ${n + 1} («${w.text}») is outlined where it is, not the whole line`, spot && Math.abs(spot.right - trueRight) < 4 && Math.abs(spot.width - trueWidth) < 6, JSON.stringify({ spot, trueRight: +trueRight.toFixed(1), trueWidth: +trueWidth.toFixed(1) }));
}
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
