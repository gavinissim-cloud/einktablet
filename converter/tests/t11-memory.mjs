import { start, makePage, tagCrops, installFake, allReady, settled, checker, dbDump, marksOf } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
const wrong = (t) => t.replace(/הקנס/g, "הקגס");
const stats = await installFake(page, truth, { lineText: wrong, wordText: wrong });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Rivka"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const ed = (i) => page.locator(".row .line-edit").nth(i);
// Put the caret in word n (0 = first) of line box `loc` and click it.
const clickWord = async (loc, n) => {
  await loc.evaluate((el, n) => {
    const text = el.textContent; let i = -1, start = 0;
    for (const m of text.matchAll(/\S+/g)) if (++i === n) { start = m.index + 1; break; }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let pos = 0, node, off = 0;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) { if (start <= pos + t.textContent.length) { node = t; off = start - pos; break; } pos += t.textContent.length; }
    const r = document.createRange(); r.setStart(node, off); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, n);
  await loc.dispatchEvent("click");
  await page.waitForSelector(".popover");
  await page.waitForTimeout(300);
  return page.locator(".popover button").allTextContents();
};
const fixesOf = async () => (await dbDump(page)).writers.find((x) => x.name === "Rivka")?.memory?.fixes?.["הקגס"];
check("read with the misreading", (await ed(4).innerText()).startsWith("הקגס"), await ed(4).innerText());
// 1. pick the right word for the first הקגס from its menu
const opts = await clickWord(ed(4), 0);
check("the menu offers the right word", opts.includes("הקנס"), JSON.stringify(opts));
await page.locator(".popover button", { hasText: /^הקנס$/ }).click();
await page.waitForSelector(".toast", { timeout: 5000 }).catch(() => {});
const toast = await page.locator(".toast").textContent().catch(() => "");
check("the other «הקגס» is only highlighted, with a note", /«הקגס» appears in 1 other place: highlighted, with «הקנס» as the first choice/.test(toast), toast);
await page.waitForTimeout(800);
check("…not changed by itself", (await ed(4).innerText()) === "הקנס אינו מובן: דצורת הקגס היא ד״ר ת״ת.", await ed(4).innerText());
check("…but highlighted", (await marksOf(page, 4)).includes("הקגס"), JSON.stringify(await marksOf(page, 4)));
let f = await fixesOf();
check("remembered for this writer", f?.to === "הקנס" && f.count === 1, JSON.stringify(f));
let w = (await dbDump(page)).writers.find((x) => x.name === "Rivka");
check("the corrected word's picture kept for teaching", (w.wordExamples || []).length === 1 && w.wordExamples[0].crop, JSON.stringify((w.wordExamples || []).map((e) => e.text)));
// 2. the other place: the correction is its first choice
const opts2 = await clickWord(ed(4), 4);
check("the other place offers the correction first", opts2[0] === "הקנס", JSON.stringify(opts2));
await page.locator(".popover button.alt").first().click();
await page.waitForTimeout(800);
check("one click fixes it", (await ed(4).innerText()) === "הקנס אינו מובן: דצורת הקנס היא ד״ר ת״ת.", await ed(4).innerText());
f = await fixesOf();
check("remembered twice now", f?.count === 2, JSON.stringify(f));
// 3. a new page by the same writer: offered, not changed by itself
await page.setInputFiles("#fileInput", `${S}/e2e/p1.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 2);
await allReady(page, stats, 2);
const card2 = page.locator("#pages > .card").nth(1);
const second = await card2.locator(".line-edit").nth(4).innerText();
check("next page: not changed by itself", second === "הקגס אינו מובן: דצורת הקגס היא ד״ר ת״ת.", second);
const marks2 = await card2.locator(".row").nth(4).locator("mark").allTextContents();
check("…highlighted", marks2.includes("הקגס"), JSON.stringify(marks2));
const opts3 = await clickWord(card2.locator(".line-edit").nth(4), 0);
check("…with the correction as the first choice", opts3[0] === "הקנס", JSON.stringify(opts3));
await page.keyboard.press("Escape");
// 4. correct it by typing (both words): now corrected 4 times
const ed2 = card2.locator(".line-edit").nth(4);
await ed2.click();
await ed2.fill("הקנס אינו מובן: דצורת הקנס היא ד״ר ת״ת.");
await page.locator("#docTitle").click(); // leave the line
await page.waitForTimeout(1500);
f = await fixesOf();
check("typing the correction is remembered too", f?.count === 4, JSON.stringify(f));
// 5. a third page: still only suggested, and Gemini sees the corrected word
const before = stats.raw.length;
await page.setInputFiles("#fileInput", `${S}/e2e/p2.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 3);
await allReady(page, stats, 3);
const card3 = page.locator("#pages > .card").nth(2);
const third = await card3.locator(".line-edit").nth(4).innerText();
check("even after 4 corrections: never changed by itself", third === "הקגס אינו מובן: דצורת הקגס היא ד״ר ת״ת.", third);
const marks = await card3.locator(".row").nth(4).locator("mark").allTextContents();
check("…highlighted", marks.includes("הקגס"), JSON.stringify(marks));
const opts4 = await clickWord(card3.locator(".line-edit").nth(4), 4);
check("…with the correction as the first choice", opts4[0] === "הקנס", JSON.stringify(opts4));
await page.keyboard.press("Escape");
const lineReq = stats.raw.slice(before).find((r) => r.kind === "lines");
check("Gemini is shown this writer's corrected words", lineReq && /How this writer writes words/.test(lineReq.raw) && /הקגס → הקנס/.test(lineReq.raw), lineReq ? "" : "no line request");
// the person's page shows what is remembered, and it survives a backup and restore
await page.click("#backHome");
await page.locator("#writerList a", { hasText: "Rivka" }).click();
await page.waitForSelector("#writerView:not([hidden])");
const view = await page.textContent("#writerView");
check("the person's page lists the remembered correction", /הקגס → הקנס/.test(view) && /suggested first/.test(view), view.slice(0, 300));
await page.click("#writerBack");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupBtn")]);
await dl.saveAs(`${S}/e2e/memory-backup.json`);
await page.locator("#writerList a", { hasText: "Rivka" }).click();
await page.waitForSelector("#writerView:not([hidden])");
await page.click("#writerDelete"); await page.click(".dialog button[type=submit]");
await page.waitForTimeout(500);
await page.setInputFiles("#restoreInput", `${S}/e2e/memory-backup.json`);
await page.click(".dialog button[type=submit]"); await page.waitForTimeout(800); await page.click(".dialog button[type=submit]");
const restored = (await dbDump(page)).writers.find((x) => x.name === "Rivka");
check("memory and word pictures survive backup and restore", restored?.memory?.fixes?.["הקגס"]?.count === 4 && restored.wordExamples?.length >= 1 && restored.wordExamples.every((e) => e.crop), JSON.stringify(restored?.memory));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
