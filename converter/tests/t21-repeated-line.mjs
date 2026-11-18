// When Gemini gives one line's reading for the picture of another (a "line" with little writing,
// such as a drawing at the top), the reading stays only on the line whose picture has the writing.
import { start, makePage, tagCrops, installFake, allReady, checker, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/repeat.png`);
await tagCrops(page);
const stats = await installFake(page, truth, { lineText: (t) => (t === TRUTH[0] ? TRUTH[1] : t) }); // the short first line read as the second
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/repeat.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const got = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText.trim()));
check("the reading isn't shown twice", got.filter((t) => t === TRUTH[1]).length === 1, JSON.stringify(got.slice(0, 3)));
check("it stays on the line with the writing", got[1] === TRUTH[1], got[1]);
// (the other line is left empty; here the word check then reads its own picture: «בס״ד»)
check("the other line no longer shows the repeated reading", got[0] !== TRUTH[1] && (got[0] === "" || got[0] === TRUTH[0]), JSON.stringify(got[0]));
check("no page errors", errors.filter((e) => !/same reading for two lines/.test(e)).length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
