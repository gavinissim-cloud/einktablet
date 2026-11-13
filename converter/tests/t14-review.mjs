// "Check words": going through the highlighted words one after another with the keyboard.
import { start, makePage, tagCrops, installFake, allReady, checker, marksOf } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
// Words that aren't real words (so they're highlighted): «הקגס» twice on line 5, «שלומ» on line 2.
const wrong = (t) => t.replace(/הקנס/g, "הקגס").replace("שלום", "שלומ");
const isShalom = (w) => w.startsWith("שלומ");
const stats = await installFake(page, truth, { lineText: wrong, wordText: wrong });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "R"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const eds = page.locator(".row .line-edit");
const all = async () => (await Promise.all([0, 1, 2, 3, 4, 5].map((i) => marksOf(page, i)))).flat();
const before = await all();
check("the page has highlighted words to check", before.some(isShalom) && before.filter((w) => w === "הקגס").length === 2, JSON.stringify(before));

await page.click(".check-words");
await page.waitForSelector(".popover .word-field");
const field = () => page.locator(".popover .word-field");
const focused = async () => page.evaluate(() => document.activeElement?.classList.contains("word-field") ? document.activeElement.value : null);
const first = await focused();
check("Check words opens the first highlighted word, its box ready to type in", first === before[0], `${first} vs ${before[0]}`);
check("…with help for the keys", /Enter.*Tab.*Esc/.test(await page.textContent(".popover .review-help")));

// Walk through every highlighted word: type the right word for the misread ones, Enter for the rest.
const seen = [];
for (let n = 0; n < 40; n++) {
  const w = await focused();
  if (w === null) break;
  seen.push(w);
  if (isShalom(w)) { await field().fill("שלום"); await page.keyboard.press("Enter"); }
  else if (w === "הקגס" && !seen.slice(0, -1).includes("הקגס")) { await field().fill("הקנס"); await page.keyboard.press("Enter"); }
  else if (w === "הקגס") await page.keyboard.press("Tab"); // the second one: skipped
  else await page.keyboard.press("Enter"); // the word is right
  await page.waitForTimeout(250);
}
check("each Enter or Tab moves on to the next highlighted word, in order, until none is left", JSON.stringify(seen) === JSON.stringify(before), JSON.stringify(seen) + " vs " + JSON.stringify(before));
check("…and then it says so", /All highlighted words are checked/.test(await page.locator(".toast").textContent().catch(() => "")));
const texts = await eds.allInnerTexts();
check("typed words replaced exactly those words", texts[1].startsWith("שלום ") && texts[4] === "הקנס אינו מובן: דצורת הקגס היא ד״ר ת״ת.", JSON.stringify([texts[1], texts[4]]));
const after = await all();
check("words confirmed with Enter are no longer highlighted; the skipped one still is", JSON.stringify(after) === JSON.stringify(["הקגס"]), JSON.stringify(after));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
