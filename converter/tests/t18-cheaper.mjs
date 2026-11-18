// What makes a page cheaper without changing what is read: Flash 3.6 by default; an answer Google
// blocks part-way is asked once of the other Flash model (not again and again); a word's choices come
// with its word-by-word reading, so its picture isn't sent a second time.
import { start, makePage, tagCrops, installFake, corruptLines, allReady, choicesOf, checker } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/cheaper.png`);
await tagCrops(page);
// The first line request is blocked by Google.
// …and one word is answered with nothing (it is asked again).
const stats = await installFake(page, truth, { lineText: corruptLines, wordOptions: true, emptyWord: "נלמד", block: (kind, n) => kind === "lines" && n === 1 });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/cheaper.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const models = stats.models;
check("Flash 3.6 by default", models.filter((m) => m === "gemini-3.6-flash").length >= models.length - 1, JSON.stringify([...new Set(models)]));
check("a blocked answer is asked once of the other Flash model", models.filter((m) => m === "gemini-3.5-flash").length === 1, JSON.stringify(models));
check("…and the page is read line by line, not as a whole page", stats.page === 0 && stats.lines === Math.ceil(6 / 3) + 1, JSON.stringify({ lines: stats.lines, page: stats.page }));
const pictures = truth.reduce((n, l) => n + l.words.length, 0);
check("a word left out is asked again on its own, not with its whole batch", stats.wordImages <= pictures + 3, `${stats.wordImages} word pictures for ${pictures} words`);
check("no separate requests for word choices (they came with the word check)", stats.options === 0, `options requests: ${stats.options}`);
const got = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
check("the word check still corrects the made-up word", got[3].startsWith("באשתו"), got[3]);
const c = await choicesOf(page, 3, "באשתו");
check("a highlighted word's choices come from the word check", c.includes("באשתוה") || c.includes("ובאשתו"), JSON.stringify(c));
check("the page shows its cost", /cost about/.test(await page.locator(".page-head .state").first().textContent()));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
