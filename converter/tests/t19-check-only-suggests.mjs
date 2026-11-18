// Where the word check would change much of a line that was cut into the wrong pieces (picture
// count far from the reading's word count), the line stays as read: the words where the readings
// differ are highlighted, with the check's reading among the choices. (On real handwriting its
// changes there broke more correct words than they fixed.)
import { start, makePage, tagCrops, installFake, allReady, marksOf, choicesOf, checker } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/suggest.png`);
await tagCrops(page);
const READ = "העיר נוסדה לפני יותר ממאה שנה (בערך). זה זה"; // the line reading: two words more than the pictures
const OTHER = { "נוסדה": "נוסע", "לפני": "לבני", "יותר": "יתר" }; // the pictures read as other real words
const stats = await installFake(page, truth, { lineText: (t) => (t.startsWith("העיר נוסדה") ? READ : t), wordText: (t) => OTHER[t] || t });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/suggest.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await allReady(page, stats);
const got = await page.locator(".row .line-edit").nth(2).innerText();
check("the line stays as it was read", got === READ, got);
const marks = await marksOf(page, 2);
check("the words the check reads differently are highlighted", ["נוסדה", "לפני", "יותר"].every((w) => marks.includes(w)), JSON.stringify(marks));
const c = await choicesOf(page, 2, "נוסדה");
check("…with the check's reading among the choices", c.includes("נוסע"), JSON.stringify(c));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
