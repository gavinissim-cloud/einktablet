import { start, makePage, tagCrops, installFake, corruptLines, settled, checker, marksOf, choicesOf, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
const stats = await installFake(page, truth, { lineText: corruptLines, delay: 400 });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
const t0 = Date.now();
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await page.waitForFunction(() => /\d+ lines/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 60000 });
const editableAfter = (Date.now() - t0) / 1000;
const first = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
await settled(page);
const got = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
const flags = await page.locator(".row").evaluateAll((rows) => rows.map((r) => r.querySelector(".choices")?.textContent || ""));
check("editable quickly (one round of line requests)", editableAfter < 8 && stats.page === 0, `${editableAfter}s, page requests ${stats.page}`);
check("lines read in parallel groups", stats.lines >= 2, JSON.stringify(stats));
check("first the line reading shows (with the made-up words)", first[3].startsWith("כשנאנס"), first[3]);
// Line 4: a made-up real word (כשנאנס) is replaced by the letter-by-letter reading (באשתו); where the
// letter-by-letter reading isn't a real word (the writer's own spelling במזנותיה), the line reading stays,
// highlighted, with the writer's spelling one click away.
const expected = TRUTH.map((t, i) => (i === 3 ? t.replace("במזנותיה", "בתשלומי׳") : t));
expected.forEach((t, i) => check(`after the word check, line ${i + 1} as expected`, got[i] === t, `got «${got[i]}»`));
const m3 = await marksOf(page, 3), m1 = await marksOf(page, 1);
check("made-up words highlighted in the text", m3.includes("באשתו") && m3.includes("בתשלומי׳"), JSON.stringify(m3));
const c1 = await choicesOf(page, 3, "באשתו");
check("clicking a word shows its other reading", c1.includes("כשנאנס") && c1.includes("✓") && c1.length <= 6, JSON.stringify(c1));
const c2 = await choicesOf(page, 3, "בתשלומי׳");
check("the writer's own spelling is one click away", c2.includes("במזנותיה"), JSON.stringify(c2));
check("missing comma highlighted", m1.includes("לכולם,"), JSON.stringify(m1));
check("at most 5 choices per word (plus ✓)", (await Promise.all(m3.map((w) => choicesOf(page, 3, w)))).every((c) => c.length <= 6));
check("no page errors", errors.length === 0, errors.join("\n"));
console.log(`editable after ${editableAfter.toFixed(1)}s with a fake reader answering in 0.4s; requests: ${JSON.stringify({ lines: stats.lines, words: stats.words, page: stats.page })}`);
await page.screenshot({ path: `${S}/e2e/t1.png`, fullPage: true });
await browser.close();
process.exit(done() ? 0 : 1);
