// A line Gemini reads nothing on stays, with a note and a button to remove it (it used to break drawing the page).
import { start, makePage, tagCrops, installFake, settled, checker } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/empty.png`);
await tagCrops(page);
// (the word check fails here, so it doesn't fill the line in)
await installFake(page, truth, { lineText: (t) => (t.startsWith("העיר") ? "" : t), fail: (kind) => (kind === "words" ? { status: 400, message: "test" } : null) });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/empty.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await settled(page);
const rows = await page.locator(".row").count();
const note = page.locator(".row .choices", { hasText: "Nothing was read on this line" });
check("the empty line is shown with a note", (await note.count()) === 1, `rows ${rows}`);
await note.locator("button", { hasText: "Remove line" }).click();
await page.waitForFunction((n) => document.querySelectorAll(".row").length === n - 1, rows);
check("Remove line removes it", (await page.locator(".row").count()) === rows - 1);
check("no page errors", errors.filter((e) => !/400/.test(e)).length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
