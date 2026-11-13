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
    const { text, dir = "auto", size = 56, wordByWord = false } = typeof line === "string" ? { text: line } : line;
    x.font = `${size}px DejaVu Sans`;
    const div = document.createElement("div");
    div.dir = dir;
    div.style.cssText = `position:absolute;left:100px;top:0;width:1800px;font:${size}px DejaVu Sans;white-space:pre;word-spacing:${Math.round(size * 0.7)}px;unicode-bidi:plaintext;text-align:start`;
    if (dir !== "auto") div.style.unicodeBidi = "isolate";
    // wordByWord: the writer put each word down in turn along the line, Hebrew words too (each word in its own place).
    div.innerHTML = text.split(" ").map((w) => `<span${wordByWord ? ` dir="${dir}"` : ""}>${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join(" ");
    document.body.append(div);
    const base = 170 + li * 210, top = base - 70, bottom = base + 25;
    const box = div.getBoundingClientRect();
    // Every character drawn exactly where the browser put it (a word's marks may stand apart from
    // its letters in mixed text); a word's place is where its letters are.
    const words = [...div.querySelectorAll("span")].map((s) => {
      const node = s.firstChild, t = node.textContent;
      let L = Infinity, R = -Infinity, mL = Infinity, mR = -Infinity;
      // each run of letters drawn whole (in its own direction) where the browser put the run; each mark on its own
      for (const m of t.matchAll(/[\u05d0-\u05ea]+|[A-Za-z0-9]+|[^\u05d0-\u05eaA-Za-z0-9]/g)) {
        const rg = document.createRange(); rg.setStart(node, m.index); rg.setEnd(node, m.index + m[0].length);
        const r = rg.getBoundingClientRect(), left = 100 + (r.left - box.left);
        x.direction = /[\u05d0-\u05ea]/.test(m[0]) ? "rtl" : "ltr"; x.textAlign = "left"; x.fillText(m[0], left, base);
        if (/[\u05d0-\u05eaA-Za-z0-9]/.test(m[0])) { L = Math.min(L, left); R = Math.max(R, left + r.width); }
        mL = Math.min(mL, left); mR = Math.max(mR, left + r.width);
      }
      if (L === Infinity) { L = mL; R = mR; } // a word that is only a mark ("-"): where the mark is
      return { text: t, left: (L / W) * 1000, right: (R / W) * 1000 };
    });
    const lineDir = getComputedStyle(div).direction;
    div.remove();
    const l = Math.min(...words.map((w) => w.left)), r = Math.max(...words.map((w) => w.right));
    out.push({ text, top: (top / H) * 1000, bottom: (bottom / H) * 1000, left: l - 15, right: r + 15, words, dir: dir === "auto" ? lineDir : dir });
  });
  window.__png = c.toDataURL("image/png");
  return out;
}, { lines, W, H });
// The English line with Hebrew words was written word by word, left to right (the Hebrew words too).
const truth = await layOut(MIXED_TRUTH.map((text, i) => (i === 3 ? { text, dir: "ltr", wordByWord: true } : text)));
fs.writeFileSync(`${S}/e2e/mixed.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
// the layout itself: English words of a Hebrew line stand left to right, and the other way round
const pos = (li, w) => truth[li].words.find((x) => x.text === w);
check("test page: «New» stands left of «York» in the Hebrew line", pos(2, "New").right <= pos(2, "York").left);
check("test page: «שלום» stands left of «עליכם» in the English line (written word by word)", pos(3, "שלום").right <= pos(3, "עליכם").left);
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
const para = (text) => paras.find((p) => p.runs.map((r) => r.t).join("").replace(/\u200e/g, "") === text.replace(/&/g, "&amp;"));
const p1 = para(MIXED_TRUTH[1]), p2 = para("היום נלמד על New Yorkshire ועל ההיסטוריה שלה."), p3 = para("The words שלום עליכן mean peace be with you.");
const FINAL = [MIXED_TRUTH[0], MIXED_TRUTH[1], "היום נלמד על New Yorkshire ועל ההיסטוריה שלה.", "The words שלום עליכן mean peace be with you.", "בשנת 1990 עברו 25 people לעיר החדשה.", MIXED_TRUTH[5]];
check("Word: every line is there, in reading order", FINAL.every((t) => para(t)), JSON.stringify(paras.map((p) => p.runs.map((r) => r.t).join(""))));
check("Word: an English line is a left-to-right paragraph", p1 && !p1.bidi && p1.runs.every((r) => !r.rtl));
check("Word: a Hebrew line with «New York» is right to left, with «New York» marked left to right", p2 && p2.bidi && p2.runs.some((r) => !r.rtl && r.t.includes("New Yorkshire")) && p2.runs.filter((r) => r.rtl).map((r) => r.t).join("|").includes("היום"), JSON.stringify(p2));
check("Word: an English line with «שלום עליכם» is left to right, each Hebrew word marked right to left and kept in its place", p3 && !p3.bidi && p3.runs.some((r) => r.rtl && r.t.includes("שלום")) && p3.runs.some((r) => r.rtl && r.t.includes("עליכן")) && p3.runs.map((r) => r.t).join("").includes("\u200e"), JSON.stringify(p3));

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
// Two lines from a real page (as the writer put them down): English sentences with Hebrew words
// written word by word along the line, left to right, each Hebrew word in its own place, and a
// colon standing at the left of «ו». Gemini's mistakes on it: Armenian look-alike letters for
// Hebrew ones, the Hebrew abbreviation «תוס׳» read as the English «The», «ד״ה» read as «מ״ה», and
// «חידוש» made up into «חידושים».
const PAGE2 = [
  "handedly broke it. The ד״ה asks מה הדין if the bench",
  "more נסב - ע״י. The תוס׳ ד״ה on :ו דף asks that",
  "we could have said a different חידוש here.",
  "The פרישה writes \"נאה יותר\" that",
];
const truth2 = await layOut(PAGE2.map((text) => ({ text, dir: "ltr", wordByWord: true, size: 48 })));
fs.writeFileSync(`${S}/e2e/mixed2.png`, Buffer.from((await page.evaluate(() => window.__png)).split(",")[1], "base64"));
{ const w = truth2[1].words; check("test page 2: its words stand left to right in the order written", w.every((x, i) => !i || w[i - 1].right < x.left)); }
await browser.close();
// (a fresh browser: a new person's first page)
({ browser, ctx, page, errors } = await start(FILE));
await tagCrops(page);
// …and Gemini types Hebrew phrases in Hebrew order although the writer put them down the other
// way round («"נאה יותר"» on the page, «"יותר נאה"» typed; «:ו דף» typed «דף ו:»), reads «פרישה» as
// «שילה», and answers nothing for the picture of the dash.
const madeUp2 = (t) => t.replace("תוס׳", "The").replace("חידוש", "חידושים").replace("\"נאה יותר\"", "\"יותר נאה\"").replace(":ו דף", "דף ו:").replace("פרישה", "שילה");
const armenian = (t) => t.replace(/ד״ה/g, "ՀՋ").replace("מה הדין", "մnu הדין");
const stats2 = await installFake(page, truth2, { lineText: (t, n) => (n === 1 ? armenian(madeUp2(t)) : madeUp2(t).replace(/ד״ה/g, "מ״ה")), wordText: (t) => (t === "-" ? "" : t) });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/mixed2.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Page2"); await page.click(".dialog button[type=submit]");
await allReady(page, stats2);
const eds2 = page.locator(".row .line-edit");
if (process.env.SHOT) await page.locator("#pages > .card").first().screenshot({ path: process.env.SHOT + "/page2-lines.png" }); // to look at
const texts2 = await eds2.allInnerTexts();
check("no letters of another alphabet anywhere (those lines were read again)", texts2.every((t) => !/[\u0530-\u058f\u0370-\u03ff\u0400-\u04ff]/.test(t)) && stats2.lines >= 2, JSON.stringify(texts2) + " " + stats2.lines);
check("«The» for «תוס׳», «מ״ה» for «ד״ה», «שילה» for «פרישה» and the made-up «חידושים» are put back as each word's picture says", JSON.stringify(texts2) === JSON.stringify(PAGE2), JSON.stringify(texts2));
check("Hebrew phrases typed in Hebrew order are turned to the order they stand on the page («\"נאה יותר\"», «:ו דף»)", texts2[3]?.includes("\"נאה יותר\"") && texts2[1]?.includes(":ו דף"), JSON.stringify(texts2));
check("…highlighted", ["תוס׳", "ד״ה"].every((w) => texts2[1] && 1) && (await marksOf(page, 1)).includes("תוס׳"), JSON.stringify(await marksOf(page, 1)));
check("lines written left to right are shown left to right", (await eds2.evaluateAll((els) => els.every((e) => e.dir === "ltr"))));
// On screen every word stands where it stands on the page: in the written order, left to right.
const placesOn = (sel) => page.locator(sel).evaluate((el) => [...el.querySelectorAll("span[dir]")].map((sp) => ({ t: sp.textContent, left: Math.round(sp.getBoundingClientRect().left), right: Math.round(sp.getBoundingClientRect().right) })));
const shownLine = await placesOn(".row:nth-child(2) .line-edit").catch(async () => eds2.nth(1).evaluate((el) => [...el.querySelectorAll("span[dir]")].map((sp) => ({ t: sp.textContent, left: Math.round(sp.getBoundingClientRect().left), right: Math.round(sp.getBoundingClientRect().right) }))));
const inOrder = (ws) => ws.length === PAGE2[1].split(" ").length && ws.every((w, i) => w.t === PAGE2[1].split(" ")[i] && (!i || ws[i - 1].right <= w.left));
check("on screen, «נסב» stands right after «more», then «-», then «ע״י.»: every word in its place", inOrder(shownLine), JSON.stringify(shownLine));
// every line: each word's letters on screen in the same left-to-right order as in the handwriting
for (let li = 0; li < PAGE2.length; li++) {
  const onScreen = await eds2.nth(li).evaluate((el) => [...el.querySelectorAll("span[dir]")].map((sp) => {
    // where the word's letters are (not its marks)
    const n = sp.firstChild.nodeType === 3 ? sp.firstChild : sp.firstChild.firstChild, t = n.textContent;
    let L = Infinity;
    for (let i = 0; i < t.length; i++) if (/[\u05d0-\u05eaA-Za-z0-9]/.test(t[i])) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); L = Math.min(L, r.getBoundingClientRect().left); }
    return { t, L };
  }));
  const screenOrder = onScreen.filter((w) => w.L < Infinity).sort((a, b) => a.L - b.L).map((w) => w.t);
  const pageOrder = truth2[li].words.filter((w) => /[\u05d0-\u05eaA-Za-z0-9]/.test(w.text)).sort((a, b) => a.left - b.left).map((w) => w.text);
  check(`line ${li + 1}: the words on screen stand in the handwriting's order`, JSON.stringify(screenOrder) === JSON.stringify(pageOrder), JSON.stringify(screenOrder) + " vs " + JSON.stringify(pageOrder));
}
const marksAt = await eds2.nth(1).evaluate((el) => {
  const at = (sp, ch) => { const n = sp.firstChild.nodeType === 3 ? sp.firstChild : sp.firstChild.firstChild; const i = n.textContent.indexOf(ch); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect(); };
  const sps = [...el.querySelectorAll("span[dir]")];
  const colon = sps.find((s) => s.textContent === ":ו"), eyi = sps.find((s) => s.textContent === "ע״י.");
  return { colonLeftOfVav: at(colon, ":").right <= at(colon, "ו").left + 1, periodRightOfAyinYud: at(eyi, ".").left >= at(eyi, "ע").right - 1 };
});
check("the colon stands at the left of «ו», as written", marksAt.colonLeftOfVav, JSON.stringify(marksAt));
check("the period stands at the right of «ע״י», as written", marksAt.periodRightOfAyinYud, JSON.stringify(marksAt));
// clicking each word of that line marks that word in the picture
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
check(`clicking each of its words marks that word in the picture (${ok2}/${words2.length})`, ok2 === words2.length, bad2.join("; "));
// «תוס׳»: the line's reading «The» is one click away
await page.keyboard.press("Escape");
await page.locator(".row").nth(1).locator("mark", { hasText: "תוס׳" }).click();
await page.waitForSelector(".popover");
const tosOpts = await page.locator(".popover button").allTextContents();
check("«תוס׳» offers the line's reading «The» as a choice", tosOpts.includes("The"), JSON.stringify(tosOpts));
await page.keyboard.press("Escape");
// document view: the same places
await page.click("#viewDoc"); await page.waitForSelector(".doc");
const docWords = await page.locator(".doc").evaluate((d) => {
  const spans = [...d.querySelectorAll("span[dir]")]; const i = spans.findIndex((s) => s.textContent === "more");
  return spans.slice(i, i + 12).map((sp) => ({ t: sp.textContent, left: Math.round(sp.getBoundingClientRect().left), right: Math.round(sp.getBoundingClientRect().right) }));
});
check("document view: every word in its place too", inOrder(docWords), JSON.stringify(docWords));
await page.locator(".doc").evaluate((d) => { d.append(""); d.dispatchEvent(new Event("input")); });
await page.waitForTimeout(1200);
const saved2 = (await dbDump(page)).docs[0].pages[0].lines.map((l) => l.text);
check("…and its invisible direction marks are never saved", JSON.stringify(saved2) === JSON.stringify(PAGE2), JSON.stringify(saved2));
await page.click("#viewLines");
// Word and TXT: the same order, kept by invisible left-to-right marks
const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#exportWord")]);
await dl2.saveAs(`${S}/e2e/mixed2.docx`);
const xml2 = execFileSync("unzip", ["-p", `${S}/e2e/mixed2.docx`, "word/document.xml"]).toString();
const q = [...xml2.matchAll(/<w:p>(.*?)<\/w:p>/g)].find((m) => m[1].includes("נסב"));
const qText = q ? [...q[1].matchAll(/<w:t[^>]*>(.*?)<\/w:t>/g)].map((m) => m[1]).join("") : "";
check("Word: a left-to-right paragraph, each Hebrew word kept in its place with a left-to-right mark", q && !q[1].includes("<w:bidi/>") && qText.replace(/\u200e/g, "") === PAGE2[1] && (qText.match(/\u200e/g) || []).length >= words2.length, qText);
const [dl3] = await Promise.all([page.waitForEvent("download"), page.click("#exportTxt")]);
await dl3.saveAs(`${S}/e2e/mixed2.txt`);
const txt2 = fs.readFileSync(`${S}/e2e/mixed2.txt`, "utf8").split("\n");
check("TXT: the same, with the marks", txt2[1].replace(/\u200e/g, "") === PAGE2[1] && txt2[1].includes("\u200e"), JSON.stringify(txt2[1]));

check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
