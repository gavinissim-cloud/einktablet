import { start, makePage, tagCrops, installFake, settled, checker, dbDump } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const TEXT = ["זה הספר של זה האיש הטוב"];
const truth = await page.evaluate((lines) => {
  const W = 2000, H = 500, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.fillStyle = "#123"; x.font = "64px DejaVu Sans"; x.direction = "rtl"; x.textAlign = "right";
  const out = [];
  lines.forEach((text, li) => {
    const base = 250, top = base - 75, bottom = base + 25; let right = 1900; const words = [];
    for (const w of text.split(" ")) { const width = x.measureText(w).width; x.fillText(w, right, base); words.push({ text: w, left: (right - width) / W * 1000, right: right / W * 1000 }); right -= width + 70; }
    out.push({ text, top: top / H * 1000, bottom: bottom / H * 1000, left: (right + 30) / W * 1000, right: 1930 / W * 1000, words });
  });
  window.__png = c.toDataURL("image/png");
  return out;
}, TEXT);
const fs = await import("node:fs");
fs.writeFileSync(`${S}/e2e/words.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
await tagCrops(page);
const stats = await installFake(page, truth);
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/words.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await settled(page);
const ed = page.locator(".row .line-edit").first();
check("line read", (await ed.innerText()) === TEXT[0], await ed.innerText());
// click a plain (not highlighted) word: the second "זה" (5th word); click near its middle
const clickWord = async (n) => {
  await ed.evaluate((el, n) => {
    const text = el.innerText; let i = -1, start = 0;
    for (const m of text.matchAll(/\S+/g)) if (++i === n) { start = m.index + 1; break; }
    const node = el.firstChild; const r = document.createRange(); r.setStart(node, start); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, n);
  await ed.dispatchEvent("click");
  await page.waitForSelector(".popover");
  await page.waitForTimeout(400);
};
await clickWord(3);
const spot = await page.locator(".word-box").first().evaluate((b) => ({ hidden: b.hidden, right: parseFloat(b.style.right), width: parseFloat(b.style.width) }));
// the 4th word from the right: its true place in the picture
const pic = truth[0]; const w4 = pic.words[3];
const W = 2000, h = (pic.bottom - pic.top) / 1000 * 500, x0 = pic.left / 1000 * W - h * 0.05, x1 = pic.right / 1000 * W + h * 0.05;
const trueRight = 100 * (1 - (w4.right / 1000 * W - x0) / (x1 - x0)), trueWidth = 100 * ((w4.right - w4.left) / 1000 * W) / (x1 - x0);
check("clicking any word marks it in the handwriting", !spot.hidden && Math.abs(spot.right - trueRight) < 4 && Math.abs(spot.width - trueWidth) < 8, JSON.stringify({ spot, trueRight, trueWidth }));
const opts = await page.locator(".popover button").allTextContents();
check("a plain word gets choices (real words one letter away)", opts.length >= 2 && opts.length <= 6, JSON.stringify(opts));
// choose an option for the SECOND "זה": only that one changes
await page.locator(".popover button.alt").first().click();
const after = await ed.innerText();
const chosen = opts[0];
check("the choice replaced exactly the clicked word (not the first «זה»)", after === `זה הספר של ${chosen} האיש הטוב`, after);
// More word options
await page.locator(".page-head button", { hasText: "More word options" }).click();
await page.waitForFunction(() => !/getting word options/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 60000 });
await page.waitForTimeout(500);
await clickWord(4);
const opts2 = await page.locator(".popover button").allTextContents();
check("More word options: Gemini's readings offered", opts2.includes("האישה") || opts2.includes("והאיש"), JSON.stringify(opts2));
check("at most 5 choices", opts2.filter((o) => o !== "✓").length <= 5, JSON.stringify(opts2));
check("options requested in the background once", stats.options >= 1, JSON.stringify(stats));
const db = await dbDump(page);
check("options saved", Object.keys(db.docs[0].pages[0].lines[0].options || {}).length >= 5, JSON.stringify(db.docs[0].pages[0].lines[0].options));
check("no page errors", errors.length === 0, errors.join("\n"));
await clickWord(2);
await page.locator(".row").first().screenshot({ path: `${S}/e2e/t10.png` });
await browser.close();
process.exit(done() ? 0 : 1);
