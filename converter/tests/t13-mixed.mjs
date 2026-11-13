// The Hebrew + English converter (hebrew-english-converter.html): pages with Hebrew lines,
// English lines, and lines with both. The test page is laid out by the browser's own text
// layout (the Unicode bidirectional algorithm), so where each word stands on the page does not
// come from the converter's code.
import { start, tagCrops, installFake, allReady, checker, dbDump } from "./harness.mjs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();

const MIXED_TRUTH = [
  "בס״ד",
  "Hello everyone, today we learn about the city.",
  "היום נלמד על New York ועל ההיסטוריה שלה.",
  "The words שלום עליכם mean peace be with you.",
  "בשנת 1990 עברו 25 families לעיר החדשה.",
  "ר׳ יוחנן said: קשה לי לומר!",
];
const W = 2000, H = 1500;
const truth = await page.evaluate(({ lines, W, H }) => {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#123"; x.font = "56px DejaVu Sans"; x.textBaseline = "alphabetic"; x.textAlign = "left";
  const out = [];
  lines.forEach((text, li) => {
    // The browser lays the line out: each line in the direction of its first letter.
    const div = document.createElement("div");
    div.dir = "auto";
    div.style.cssText = "position:absolute;left:100px;top:0;width:1800px;font:56px DejaVu Sans;white-space:pre;word-spacing:40px;unicode-bidi:plaintext;text-align:start";
    div.innerHTML = text.split(" ").map((w) => `<span>${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join(" ");
    document.body.append(div);
    const base = 170 + li * 210, top = base - 70, bottom = base + 25;
    const box = div.getBoundingClientRect();
    const words = [...div.querySelectorAll("span")].map((s) => {
      const r = s.getBoundingClientRect();
      const left = 100 + (r.left - box.left);
      x.direction = /[א-ת]/.test(s.textContent) ? "rtl" : "ltr";
      x.textAlign = "left";
      x.fillText(s.textContent, left, base);
      return { text: s.textContent, left: (left / W) * 1000, right: ((left + r.width) / W) * 1000 };
    });
    div.remove();
    const l = Math.min(...words.map((w) => w.left)), r = Math.max(...words.map((w) => w.right));
    out.push({ text, top: (top / H) * 1000, bottom: (bottom / H) * 1000, left: l - 15, right: r + 15, words });
  });
  window.__png = c.toDataURL("image/png");
  return out;
}, { lines: MIXED_TRUTH, W, H });
fs.writeFileSync(`${S}/e2e/mixed.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
// the layout itself: English words of a Hebrew line stand left to right, and the other way round
const pos = (li, w) => truth[li].words.find((x) => x.text === w);
check("test page: «New» stands left of «York» in the Hebrew line", pos(2, "New").right <= pos(2, "York").left);
check("test page: «שלום» stands right of «עליכם» in the English line", pos(3, "שלום").left >= pos(3, "עליכם").right);
check("test page: the English line starts on the left", pos(1, "Hello").left < 100);

await tagCrops(page);
// A misread English word ("learn" read as "leam") must be flagged with the right word as a choice.
const misread = (t) => t.replace("learn", "leam");
const stats = await installFake(page, truth, { lineText: misread, wordText: misread });
check("the Hebrew + English converter has its own title", (await page.textContent("h1")).includes("Hebrew + English"));
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/mixed.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Mixed"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const eds = page.locator(".row .line-edit");
const texts = await eds.allInnerTexts();
const expect = MIXED_TRUTH.map(misread);
check("every line read, in reading order", texts.length === expect.length && texts.every((t, i) => t === expect[i]), JSON.stringify(texts));
const lineReq = await page.evaluate(() => INSTRUCTIONS + MIXED_RULES);
check("Gemini is told the pages mix Hebrew and English: each word in its own script, in reading order", /never transliterate/.test(lineReq) && /reading order \(Hebrew right to left, English left to right\)/.test(lineReq));
check("English words were checked word by word too (the all-English line)", stats.words > 0 && stats.raw.some((r) => r.kind === "words" && /ONE handwritten word, Hebrew or English/.test(r.raw)));

// Direction of each line box: English lines run left to right, Hebrew lines right to left.
const dirs = await eds.evaluateAll((els) => els.map((el) => {
  const r = document.createRange(); r.selectNodeContents(el);
  const t = r.getBoundingClientRect(), b = el.getBoundingClientRect();
  return { left: Math.round(t.left - b.left), right: Math.round(b.right - t.right) };
}));
check("Hebrew lines stand on the right of their box", [0, 2, 4, 5].every((i) => dirs[i].right < 30), JSON.stringify(dirs));
check("English lines stand on the left of their box", [1, 3].every((i) => dirs[i].left < 30), JSON.stringify(dirs));

// The misread English word: flagged, with the right word among its choices.
check("a misread English word is highlighted", (await page.locator(".row").nth(1).locator("mark").allTextContents()).includes("leam"));

// Click every word of every line with the mouse, where it shows on screen: the menu is for that
// word, and the box on the picture is on that word.
const lines = await page.evaluate(() => state.doc.pages[0].lines.map((l) => ({ top: l.top, bottom: l.bottom, left: l.left, right: l.right })));
let spotsOk = 0, spotsAll = 0, menusOk = 0;
const bad = [];
for (let li = 0; li < MIXED_TRUTH.length; li++) {
  const words = expect[li].split(" ");
  for (let wi = 0; wi < words.length; wi++) {
    const ed = eds.nth(li);
    await page.keyboard.press("Escape");
    await ed.scrollIntoViewIfNeeded();
    const at = await ed.evaluate((el, wi) => {
      const text = el.textContent; const m = [...text.matchAll(/\S+/g)][wi];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0, node, off = 0;
      const mid = m.index + Math.floor(m[0].length / 2);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (mid < pos + n.textContent.length) { node = n; off = mid - pos; break; } pos += n.textContent.length; }
      const r = document.createRange(); r.setStart(node, off); r.setEnd(node, off + 1);
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, wi);
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector(".popover", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
    // the menu belongs to the clicked word: its buttons' titles name it
    const titles = await page.locator(".popover button").evaluateAll((bs) => bs.map((b) => b.title));
    if (titles.length && titles.every((t) => t.includes(`«${words[wi]}»`) || t.startsWith("Use «"))) menusOk++;
    else bad.push(`menu for ${words[wi]}: ${JSON.stringify(titles)}`);
    // where the box is on the picture vs where the word truly is
    const spot = await page.locator(".row").nth(li).locator(".word-box").evaluate((b) => (b.hidden ? null : { right: parseFloat(b.style.right), width: parseFloat(b.style.width) }), null, { timeout: 2000 }).catch(() => null);
    const tw = truth[li].words[wi], L = lines[li];
    const h = ((L.bottom - L.top) / 1000) * H, x0 = Math.max(0, (L.left / 1000) * W - h * 0.05), x1 = Math.min(W, (L.right / 1000) * W + h * 0.05);
    const trueMid = 100 * (1 - (((tw.left + tw.right) / 2 / 1000) * W - x0) / (x1 - x0));
    spotsAll++;
    if (spot && trueMid >= spot.right - 1 && trueMid <= spot.right + spot.width + 1) spotsOk++;
    else bad.push(`${words[wi]}: ${JSON.stringify(spot)} true ${trueMid.toFixed(1)}`);
  }
}
check(`the picture box lands on the clicked word (${spotsOk}/${spotsAll})`, spotsOk === spotsAll, bad.join("; "));
check(`clicking a word opens the menu for that word (${menusOk}/${spotsAll})`, menusOk === spotsAll, bad.join("; "));

// Gemini's word options are given to the right word on a line with both languages.
await page.keyboard.press("Escape");
await page.locator(".row").nth(2).locator(".line-edit").evaluate((el) => {
  const i = el.textContent.indexOf("York") + 1; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (i < pos + n.textContent.length) { const r = document.createRange(); r.setStart(n, i - pos); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); break; } pos += n.textContent.length; }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForSelector(".popover");
const yorkOpts = await page.locator(".popover button").allTextContents();
check("Gemini's readings of «York» are offered for «York» (not a neighbour's)", yorkOpts.includes("Yorkה"), JSON.stringify(yorkOpts));
await page.keyboard.press("Escape");
await page.locator(".row").nth(1).locator("mark", { hasText: "leam" }).click();
await page.waitForSelector(".popover");
const leamOpts = await page.locator(".popover button").allTextContents();
check("…and real English words that look alike, «learn» among them", leamOpts.includes("learn"), JSON.stringify(leamOpts));
await page.locator(".popover button", { hasText: /^learn$/ }).click();
await page.waitForTimeout(600);
check("choosing it fixes exactly that word", (await eds.nth(1).innerText()) === MIXED_TRUTH[1], await eds.nth(1).innerText());

// Editing: typing in the middle of an English word inside a Hebrew line.
const ed2 = eds.nth(2);
await ed2.evaluate((el) => {
  const i = el.textContent.indexOf("York") + 2; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (i <= pos + n.textContent.length) { const r = document.createRange(); r.setStart(n, i - pos); r.collapse(true); el.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); break; } pos += n.textContent.length; }
});
await page.keyboard.type("X");
await page.keyboard.press("Backspace");
await page.keyboard.type("r");
check("typing inside an English word of a Hebrew line goes exactly there", (await ed2.innerText()) === "היום נלמד על New Yorrk ועל ההיסטוריה שלה.", await ed2.innerText());
await page.keyboard.press("Backspace");
await page.locator("#docTitle").click();
await page.waitForTimeout(800);

// Document view: each line in its own direction.
await page.click("#viewDoc"); await page.waitForSelector(".doc");
const docDir = await page.locator(".doc").evaluate((d) => getComputedStyle(d).unicodeBidi);
check("document view: each line runs in its own direction", docDir === "plaintext", docDir);
await page.click("#viewLines"); await page.waitForSelector(".row .line-edit");

// Word export: Hebrew lines as right-to-left paragraphs, English ones left to right, and each
// stretch of words marked with its own direction.
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportWord")]);
await dl.saveAs(`${S}/e2e/mixed.docx`);
const xml = execFileSync("unzip", ["-p", `${S}/e2e/mixed.docx`, "word/document.xml"]).toString();
const paras = [...xml.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) => ({ bidi: m[1].includes("<w:bidi/>"), runs: [...m[1].matchAll(/<w:r>(.*?)<\/w:r>/g)].map((r) => ({ rtl: r[1].includes("<w:rtl/>"), t: (r[1].match(/<w:t[^>]*>(.*?)<\/w:t>/) || [])[1] })) }));
const para = (text) => paras.find((p) => p.runs.map((r) => r.t).join("") === text.replace(/&/g, "&amp;"));
const p1 = para(MIXED_TRUTH[1]), p2 = para(MIXED_TRUTH[2]), p3 = para(MIXED_TRUTH[3]);
check("Word: every line is there, in reading order", MIXED_TRUTH.every((t) => para(t)), JSON.stringify(paras.map((p) => p.runs.map((r) => r.t).join(""))));
check("Word: an English line is a left-to-right paragraph", p1 && !p1.bidi && p1.runs.every((r) => !r.rtl));
check("Word: a Hebrew line with «New York» is right to left, with «New York» marked left to right", p2 && p2.bidi && p2.runs.some((r) => !r.rtl && r.t.includes("New York")) && p2.runs.filter((r) => r.rtl).map((r) => r.t).join("|").includes("היום"), JSON.stringify(p2));
check("Word: an English line with «שלום עליכם» is left to right, with the Hebrew marked right to left", p3 && !p3.bidi && p3.runs.some((r) => r.rtl && r.t.includes("שלום עליכם")), JSON.stringify(p3));

// Fully separate from the Hebrew-only converter: its own storage, settings and key.
const db = await dbDump(page);
check("saved in its own storage", db.docs.length === 1 && (await page.evaluate(() => APP_ID)) === "hebrew-english-converter");
const keys = await page.evaluate(() => Object.keys(localStorage));
check("its settings and key are kept apart (he-en: …)", keys.length > 0 && keys.every((k) => k.startsWith("he-en:")), JSON.stringify(keys));
const heb = await ctx.newPage();
await heb.goto("file://" + FILE.replace("hebrew-english-converter.html", "hebrew-converter.html"));
await heb.waitForTimeout(800);
check("the Hebrew-only converter, in the same browser, has none of it (asks for its own key)", await heb.isVisible("#keyInput"));
await heb.fill("#keyInput", "AQ.k"); await heb.click("#keySave");
await heb.waitForTimeout(500);
check("…and lists no documents or people from it", (await heb.locator("#docList a").count()) === 0 && (await heb.locator("#writerList a").count()) === 0);
// a backup of one can't be restored into the other
await page.click("#backHome");
const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#backupBtn")]);
await bk.saveAs(`${S}/e2e/mixed-backup.json`);
await heb.setInputFiles("#restoreInput", `${S}/e2e/mixed-backup.json`);
await heb.waitForTimeout(500);
check("a Hebrew + English backup is refused by the Hebrew-only converter", /Hebrew \+ English converter/.test(await heb.textContent(".dialog p").catch(() => "")));
await heb.close();
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
