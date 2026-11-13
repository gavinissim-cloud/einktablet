// Word choices from Gemini: prepared ahead only for the highlighted words; any other word gets
// them when it is clicked (one small request), the same readings as before.
import { start, makePage, tagCrops, installFake, allReady, checker, marksOf, dbDump } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
const wrong = (t) => t.replace(/הקנס/g, "הקגס");
const stats = await installFake(page, truth, { lineText: wrong, wordText: wrong });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "C"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const marked = (await Promise.all([0, 1, 2, 3, 4, 5].map((i) => marksOf(page, i)))).flat();
const optionImages = () => stats.raw.filter((r) => r.kind === "options").reduce((n, r) => n + (r.raw.match(/"text":"Image \d+:"/g) || []).length, 0);
const wordCount = (await page.locator(".row .line-edit").allInnerTexts()).join(" ").split(/\s+/).filter(Boolean).length;
const ahead = optionImages();
check(`choices prepared ahead only for the highlighted words (${ahead} pictures for ${marked.length} highlighted of ${wordCount} words)`, ahead === marked.length, JSON.stringify(marked));
// the highlighted «הקגס» has Gemini's readings at once
await page.locator(".row").nth(4).locator("mark", { hasText: "הקגס" }).first().click();
await page.waitForSelector(".popover");
const hk = await page.locator(".popover button").allTextContents();
// (the fake Gemini reads each picture as the true word, «הקנס», and offers «הקנסה», «והקנס» too)
check("a highlighted word shows Gemini's readings right away", hk.includes("הקנס") && hk.includes("והקנס") && !(await page.locator(".popover .waiting").count()), JSON.stringify(hk));
await page.keyboard.press("Escape");
// a plain word: its readings are asked when it is clicked, in one small request, and shown
const before = stats.options;
const ed = page.locator(".row .line-edit").nth(1);
await ed.evaluate((el) => {
  const text = el.textContent, m = [...text.matchAll(/\S+/g)][2];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (m.index + 1 <= pos + n.textContent.length) { const r = document.createRange(); r.setStart(n, m.index + 1 - pos); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); break; } pos += n.textContent.length; }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForSelector(".popover");
const word = (await ed.innerText()).split(" ")[2];
await page.waitForFunction(() => !document.querySelector(".popover .waiting"), null, { timeout: 15000 }).catch(() => {});
const plain = await page.locator(".popover button").allTextContents();
const lastOptions = stats.raw.filter((r) => r.kind === "options").at(-1);
check("clicking a plain word asks Gemini for its readings: one request, one picture", stats.options === before + 1 && (lastOptions.raw.match(/"text":"Image \d+:"/g) || []).length === 1, `${before} -> ${stats.options}`);
check("…and shows them in the menu", plain.includes("ו" + word), JSON.stringify(plain) + " " + word);
await page.keyboard.press("Escape");
// asked once: clicking it again uses what was kept
await ed.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForTimeout(600);
check("…asked only once (kept for next time)", stats.options === before + 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
const db = await dbDump(page);
check("…and saved", (db.docs[0].pages[0].lines[1].options || {})[word]?.length >= 2, JSON.stringify(db.docs[0].pages[0].lines[1].options));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
