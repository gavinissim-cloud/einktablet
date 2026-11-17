// While a line is edited, the word the cursor is in stays outlined in the handwriting picture:
// after clicking it, while typing, after moving with the arrow keys; gone once the line is left.
import { start, makePage, tagCrops, installFake, corruptLines, settled, checker } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/outline.png`);
await tagCrops(page);
await installFake(page, truth, { lineText: corruptLines });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/outline.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await settled(page);
await page.waitForTimeout(1000);
const row = page.locator(".row").nth(3), ed = row.locator(".line-edit");
const box = () => row.locator(".word-box").evaluate((b) => (b.hidden ? null : b.style.right));
const bb = await ed.boundingBox();
await ed.click({ position: { x: bb.width - 30, y: bb.height / 2 } }); // the first word (right end)
await page.waitForTimeout(600);
const first = await box();
check("the clicked word is outlined", first !== null, String(first));
await page.keyboard.type("א"); await page.waitForTimeout(600);
check("still outlined while typing over it", (await box()) === first, String(await box()));
for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft"); // right to left: on to a later word
await page.waitForTimeout(600);
const moved = await box();
check("the outline follows the cursor to another word", moved !== null && moved !== first, `${first} → ${moved}`);
await page.locator("#docTitle").click(); await page.waitForTimeout(600);
check("gone once the line is left", (await row.locator(".word-box").evaluate((b) => b.hidden)) === true);
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
