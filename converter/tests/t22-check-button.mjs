// The word check is most of a page's price: by default it doesn't run by itself. A page is read
// (lines, highlights, cost shown); "Check every word" runs it on that page; Settings can turn it on.
import { start, makePage, tagCrops, installFake, corruptLines, allReady, settled, checker } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE, { wordCheck: false });
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/button.png`);
await tagCrops(page);
const stats = await installFake(page, truth, { lineText: corruptLines });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/button.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
await page.waitForTimeout(800);
check("by default no word check runs by itself", stats.words === 0 && stats.options === 0, JSON.stringify({ words: stats.words, options: stats.options }));
const label = await page.locator(".page-head .state").first().textContent();
check("the page is read and shows its cost", /6 lines/.test(label) && /cost about/.test(label) && !/checking/.test(label), label);
let got = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
check("the line reading is shown as read", got[3].startsWith("כשנאנס"), got[3]);
// a word's choices are read when it is clicked (one small request)
await page.locator(".row").nth(3).locator(".line-edit mark", { hasText: "במזנותיה" }).click(); // highlighted: not in the dictionary
await page.waitForSelector(".popover");
check("while Gemini reads it, the menu says so (no look-alike words)", (await page.locator(".popover .waiting", { hasText: "reading the handwriting" }).count()) === 1 && (await page.locator(".popover button.alt").count()) === 0);
await page.waitForFunction(() => !document.querySelector(".popover .waiting"), null, { timeout: 20000 });
const c = await page.locator(".popover button").allTextContents();
await page.keyboard.press("Escape");
check("clicking a word gets Gemini's readings of its picture", stats.options === 1 && c.length >= 2, JSON.stringify({ c, options: stats.options }));
// the button runs the check on this page
const btn = page.locator(".page-head button", { hasText: "Check every word" });
check("a 'Check every word' button is on the page", (await btn.count()) === 1);
await page.evaluate(() => { window.__autoOptionsDone = 0; });
await btn.click();
await page.waitForFunction(() => (window.__autoOptionsDone || 0) >= 1, null, { timeout: 60000 });
await settled(page);
got = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
check("…which reads every word and catches the made-up word", stats.words > 0 && got[3].startsWith("באשתו"), JSON.stringify({ words: stats.words, line: got[3] }));
check("…and is then gone from the page", (await page.locator(".page-head button", { hasText: "Check every word" }).count()) === 0);
// Settings: on every page
await page.click("#settingsBtn");
const box = page.locator("#wordCheck");
check("Settings: the word check on every page, off by default", (await box.count()) === 1 && !(await box.isChecked()));
await box.check(); await page.click(".dialog button[type=submit]");
check("…and can be turned on", await page.evaluate(() => localStorage.getItem("word_check") === "on"));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
