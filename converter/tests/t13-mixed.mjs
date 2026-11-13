// The Hebrew + English converter (hebrew-english-converter.html): pages with Hebrew lines,
// English lines, and lines with both. The test page is laid out by the browser's own text
// layout (the Unicode bidirectional algorithm), so where each word stands on the page does not
// come from the converter's code.
import { start, tagCrops, installFake, allReady, checker, dbDump, marksOf } from "./harness.mjs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const [S, FILE] = process.argv.slice(2);
let { browser, ctx, page, errors } = await start(FILE);
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
// Lay a page out the way it is written: each line in its direction ("auto": that of its first
// letter), by the browser's own text layout; returns the true words with their places.
const layOut = (lines) => page.evaluate(({ lines, W, H }) => {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#123"; x.font = "56px DejaVu Sans"; x.textBaseline = "alphabetic"; x.textAlign = "left";
  const out = [];
  lines.forEach((line, li) => {
    const { text, dir = "auto", size = 56 } = typeof line === "string" ? { text: line } : line;
    x.font = `${size}px DejaVu Sans`;
    const div = document.createElement("div");
    div.dir = dir;
    div.style.cssText = `position:absolute;left:100px;top:0;width:1800px;font:${size}px DejaVu Sans;white-space:pre;word-spacing:${Math.round(size * 0.7)}px;unicode-bidi:plaintext;text-align:start`;
    if (dir !== "auto") div.style.unicodeBidi = "isolate";
    div.innerHTML = text.split(" ").map((w) => `<span>${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join(" ");
    document.body.append(div);
    const base = 170 + li * 210, top = base - 70, bottom = base + 25;
    const box = div.getBoundingClientRect();
    // Every character drawn exactly where the browser put it (a word's marks may stand apart from
    // its letters in mixed text); a word's place is where its letters are.
    const words = [...div.querySelectorAll("span")].map((s) => {
      const node = s.firstChild, t = node.textContent;
      let L = Infinity, R = -Infinity;
      // each run of letters drawn whole (in its own direction) where the browser put the run; each mark on its own
      for (const m of t.matchAll(/[\u05d0-\u05ea]+|[A-Za-z0-9]+|[^\u05d0-\u05eaA-Za-z0-9]/g)) {
        const rg = document.createRange(); rg.setStart(node, m.index); rg.setEnd(node, m.index + m[0].length);
        const r = rg.getBoundingClientRect(), left = 100 + (r.left - box.left);
        x.direction = /[\u05d0-\u05ea]/.test(m[0]) ? "rtl" : "ltr"; x.textAlign = "left"; x.fillText(m[0], left, base);
        if (/[\u05d0-\u05eaA-Za-z0-9]/.test(m[0])) { L = Math.min(L, left); R = Math.max(R, left + r.width); }
      }
      return { text: t, left: (L / W) * 1000, right: (R / W) * 1000 };
    });
    div.remove();
    const l = Math.min(...words.map((w) => w.left)), r = Math.max(...words.map((w) => w.right));
    out.push({ text, top: (top / H) * 1000, bottom: (bottom / H) * 1000, left: l - 15, right: r + 15, words });
  });
  window.__png = c.toDataURL("image/png");
  return out;
}, { lines, W, H });
const truth = await layOut(MIXED_TRUTH);
fs.writeFileSync(`${S}/e2e/mixed.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
// the layout itself: English words of a Hebrew line stand left to right, and the other way round
const pos = (li, w) => truth[li].words.find((x) => x.text === w);
check("test page: «New» stands left of «York» in the Hebrew line", pos(2, "New").right <= pos(2, "York").left);
check("test page: «שלום» stands right of «עליכם» in the English line", pos(3, "שלום").left >= pos(3, "עליכם").right);
check("test page: the English line starts on the left", pos(1, "Hello").left < 100);

await tagCrops(page);
// A misread English word ("learn" read as "leam") must be flagged with the right word as a choice.
const misread = (t) => t.replace("learn", "leam");
// …and the line reading makes up words from the sentence in lines with both languages (as Gemini
// does), while each word's own picture says what is written: the word check must put those back.
const madeUp = (t) => t.replace("עליכם", "עליהם").replace("קשה", "קשא").replace("families", "familys");
// Gemini's own readings of each word picture: real words, different for each word.
const OPTIONS = { York: ["York", "Work", "Yolk"], New: ["New", "Now", "Hew"], "על": ["על", "עד"], "ועל": ["ועל", "ועד"] };
const stats = await installFake(page, truth, { lineText: (t) => madeUp(misread(t)), wordText: misread, optionsFor: (w) => OPTIONS[w] || [w, w + "ה", "ו" + w] });
check("the Hebrew + English converter has its own title", (await page.textContent("h1")).includes("Hebrew + English"));
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/mixed.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Mixed"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const eds = page.locator(".row .line-edit");
const texts = await eds.allInnerTexts();
const expect = MIXED_TRUTH.map(misread);
check("every line read, in reading order", texts.length === expect.length && texts.every((t, i) => t === expect[i]), JSON.stringify(texts));
check("words made up from the sentence in lines with both languages are replaced by what each word's picture says", texts[3].includes("עליכם") && texts[5].includes("קשה") && texts[4].includes("families"), JSON.stringify(texts));
const fixedMarks = [...(await marksOf(page, 3)), ...(await marksOf(page, 4)), ...(await marksOf(page, 5))];
check("…highlighted, so they can be checked", ["עליכם", "families", "קשה"].every((w) => fixedMarks.includes(w)), JSON.stringify(fixedMarks));
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
check("Gemini's readings of «York» are offered for «York» (not a neighbour's)", yorkOpts.includes("Work") && yorkOpts.includes("Yolk") && !yorkOpts.includes("Now"), JSON.stringify(yorkOpts));
check("…and readings in the other alphabet or made up are left out", !yorkOpts.some((o) => /[\u05d0-\u05ea]/.test(o)), JSON.stringify(yorkOpts));
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

// Typing an English word at the start of a Hebrew line: the line keeps its direction while it is
// edited (it doesn't jump to left to right), and the words keep their places.
const before2 = await ed2.innerText();
await ed2.evaluate((el) => { const r = document.createRange(); r.setStart(el.firstChild, 0); r.collapse(true); el.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); });
await page.keyboard.type("Hi ");
const look = await ed2.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const t = r.getBoundingClientRect(), b = el.getBoundingClientRect(); return { dir: getComputedStyle(el).direction, right: Math.round(b.right - t.right) }; });
check("typing English first in a Hebrew line doesn't flip it to left to right", look.dir === "rtl" && look.right < 30 && (await ed2.innerText()) === "Hi " + before2, JSON.stringify(look) + " " + (await ed2.innerText()));
for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
check("…and deleting it again leaves the line as it was", (await ed2.innerText()) === before2, await ed2.innerText());
await page.locator("#docTitle").click();
await page.waitForTimeout(600);

// Typing a word in the menu's own box (no caret between Hebrew and English letters).
const typeWord = async (li, find, newWord) => {
  const ed = eds.nth(li);
  await ed.scrollIntoViewIfNeeded();
  const r = await ed.evaluate((el, find) => { const i = el.textContent.indexOf(find) + 1; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0; for (let n = w.nextNode(); n; n = w.nextNode()) { if (i < pos + n.textContent.length) { const r = document.createRange(); r.setStart(n, i - pos); r.setEnd(n, i - pos + 1); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } pos += n.textContent.length; } }, find);
  await page.mouse.click(r.x, r.y);
  await page.waitForSelector(".popover .word-field");
  const field = page.locator(".popover .word-field");
  const shown = await field.inputValue();
  await field.click(); await field.fill(newWord); await field.press("Enter");
  await page.waitForTimeout(500);
  return shown;
};
let shown = await typeWord(2, "York", "Yorkshire");
check("the word box shows the clicked English word", shown === "York", shown);
check("typing in it replaces exactly that word", (await eds.nth(2).innerText()) === "היום נלמד על New Yorkshire ועל ההיסטוריה שלה.", await eds.nth(2).innerText());
shown = await typeWord(3, "עליכם", "עליכן");
check("…and a Hebrew word inside an English line", shown === "עליכם" && (await eds.nth(3).innerText()) === "The words שלום עליכן mean peace be with you.", shown + " / " + (await eds.nth(3).innerText()));
shown = await typeWord(4, "families", "people");
check("…and an English word between numbers in a Hebrew line", (await eds.nth(4).innerText()) === "בשנת 1990 עברו 25 people לעיר החדשה.", await eds.nth(4).innerText());
await page.waitForTimeout(800);
const mem = (await dbDump(page)).writers.find((w) => w.name === "Mixed")?.memory?.fixes || {};
check("words typed in the box are remembered as corrections", mem.York?.to === "Yorkshire" && mem["עליכם"]?.to === "עליכן", JSON.stringify(mem));

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
const p1 = para(MIXED_TRUTH[1]), p2 = para("היום נלמד על New Yorkshire ועל ההיסטוריה שלה."), p3 = para("The words שלום עליכן mean peace be with you.");
const FINAL = [MIXED_TRUTH[0], MIXED_TRUTH[1], "היום נלמד על New Yorkshire ועל ההיסטוריה שלה.", "The words שלום עליכן mean peace be with you.", "בשנת 1990 עברו 25 people לעיר החדשה.", MIXED_TRUTH[5]];
check("Word: every line is there, in reading order", FINAL.every((t) => para(t)), JSON.stringify(paras.map((p) => p.runs.map((r) => r.t).join(""))));
check("Word: an English line is a left-to-right paragraph", p1 && !p1.bidi && p1.runs.every((r) => !r.rtl));
check("Word: a Hebrew line with «New York» is right to left, with «New York» marked left to right", p2 && p2.bidi && p2.runs.some((r) => !r.rtl && r.t.includes("New Yorkshire")) && p2.runs.filter((r) => r.rtl).map((r) => r.t).join("|").includes("היום"), JSON.stringify(p2));
check("Word: an English line with «שלום עליכם» is left to right, with the Hebrew marked right to left", p3 && !p3.bidi && p3.runs.some((r) => r.rtl && r.t.includes("שלום עליכן")), JSON.stringify(p3));

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
// An English page whose lines fill the width, one of them starting with a Hebrew quote: written
// left to right like the rest of the page, so it must show and be matched left to right too
// (not as a Hebrew line because its first letter is Hebrew).
const PAGE2 = [
  "The Gemara asks why only the last one is חייב and not the others",
  "\"דבקה קסמין בהו תגר\" and the חידוש is כוחו כגופו so we learn",
  "from here that all who sit on the bench share in the damage.",
];
const truth2 = await layOut(PAGE2.map((text) => ({ text, dir: "ltr", size: 44 })));
fs.writeFileSync(`${S}/e2e/mixed2.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
{ const q = truth2[1].words.slice(0, 4), and = truth2[1].words.find((w) => w.text === "and");
  check("test page 2: the Hebrew quote stands at the left start of its line, before «and»", Math.min(...q.map((w) => w.left)) < 100 && q.every((w) => w.right < and.left)); }
await browser.close();
// (a fresh browser: a new person's first page)
({ browser, ctx, page, errors } = await start(FILE));
await tagCrops(page);
const stats2 = await installFake(page, truth2, { lineText: (t) => t.replace("חידוש", "חידושים") });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/mixed2.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Page2"); await page.click(".dialog button[type=submit]");
await allReady(page, stats2);
await page.waitForFunction(() => /\d+ lines/.test(document.querySelector(".page-head .state")?.textContent || "") && !/checking|getting/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 60000 });
const eds2 = page.locator(".row .line-edit");
check("page 2 read (the made-up «חידושים» put back to «חידוש», as its picture says)", JSON.stringify(await eds2.allInnerTexts()) === JSON.stringify(PAGE2), JSON.stringify(await eds2.allInnerTexts()));
check("the line starting with a Hebrew quote shows left to right, like its page", (await eds2.nth(1).getAttribute("dir")) === "ltr" && (await eds2.nth(0).getAttribute("dir")) === "ltr");
// the whole quote (a right-to-left stretch) stands at the left start, "and the" after it on the right
const quoteAt = await eds2.nth(1).evaluate((el) => {
  const t = el.textContent, q = t.indexOf("\" and"), node = el.firstChild, b = el.getBoundingClientRect();
  const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, q + 1);
  const r2 = document.createRange(); r2.setStart(node, q + 2); r2.setEnd(node, q + 5);
  return { quoteLeft: Math.round(r.getBoundingClientRect().left - b.left), quoteRight: Math.round(r.getBoundingClientRect().right - b.left), andLeft: Math.round(r2.getBoundingClientRect().left - b.left) };
});
check("…with the quote at its left start, and the English after it", quoteAt.quoteLeft < 30 && quoteAt.andLeft > quoteAt.quoteRight, JSON.stringify(quoteAt));
const lines2 = await page.evaluate(() => state.doc.pages[0].lines.map((l) => ({ top: l.top, bottom: l.bottom, left: l.left, right: l.right })));
let ok2 = 0; const bad2 = [];
const words2 = PAGE2[1].split(" ");
for (let wi = 0; wi < words2.length; wi++) {
  await page.keyboard.press("Escape");
  const ed = eds2.nth(1); await ed.scrollIntoViewIfNeeded();
  const at = await ed.evaluate((el, wi) => {
    const m = [...el.textContent.matchAll(/\S+/g)][wi]; const mid = m.index + Math.floor(m[0].length / 2);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0;
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (mid < pos + n.textContent.length) { const r = document.createRange(); r.setStart(n, mid - pos); r.setEnd(n, mid - pos + 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } pos += n.textContent.length; }
  }, wi);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  const spot = await page.locator(".row").nth(1).locator(".word-box").evaluate((b) => (b.hidden ? null : { right: parseFloat(b.style.right), width: parseFloat(b.style.width) }), null, { timeout: 2000 }).catch(() => null);
  const tw = truth2[1].words[wi], L = lines2[1];
  const h = ((L.bottom - L.top) / 1000) * H, x0 = Math.max(0, (L.left / 1000) * W - h * 0.05), x1 = Math.min(W, (L.right / 1000) * W + h * 0.05);
  const trueMid = 100 * (1 - (((tw.left + tw.right) / 2 / 1000) * W - x0) / (x1 - x0));
  if (spot && trueMid >= spot.right - 1 && trueMid <= spot.right + spot.width + 1) ok2++; else bad2.push(`${words2[wi]}: ${JSON.stringify(spot)} true ${trueMid.toFixed(1)}`);
}
check(`…and clicking each of its words marks that word in the picture (${ok2}/${words2.length})`, ok2 === words2.length, bad2.join("; "));
await page.keyboard.press("Escape");
await page.click("#viewDoc"); await page.waitForSelector(".doc");
const docLine = await page.locator(".doc").evaluate((d) => {
  // where the quote of the second line stands in the document view
  const t = d.firstChild.nodeType === 3 ? null : null;
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT); let found = null;
  for (let n = walker.nextNode(); n && !found; n = walker.nextNode()) { const i = n.textContent.indexOf("\"דבקה"), j = n.textContent.indexOf("\" and"); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, j + 1); found = Math.round(r.getBoundingClientRect().left - d.getBoundingClientRect().left); } }
  return found;
});
check("document view: that line stands left to right too (the quote on the left)", docLine !== null && docLine < 50, String(docLine));
// editing in the document view keeps the text clean (the direction marks are never saved)
await page.locator(".doc").evaluate((d) => { d.append(""); d.dispatchEvent(new Event("input")); });
await page.waitForTimeout(1200);
const saved2 = (await dbDump(page)).docs[0].pages[0].lines.map((l) => l.text);
check("…and its direction marks are never saved", JSON.stringify(saved2) === JSON.stringify(PAGE2), JSON.stringify(saved2));
await page.click("#viewLines");
const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#exportWord")]);
await dl2.saveAs(`${S}/e2e/mixed2.docx`);
const xml2 = execFileSync("unzip", ["-p", `${S}/e2e/mixed2.docx`, "word/document.xml"]).toString();
const q = [...xml2.matchAll(/<w:p>(.*?)<\/w:p>/g)].find((m) => m[1].includes("דבקה"));
check("Word: that line is a left-to-right paragraph, the quote marked right to left", q && !q[1].includes("<w:bidi/>") && /<w:rtl\/>[^]*?דבקה/.test(q[1]), q ? q[1].slice(0, 300) : "missing");

check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
