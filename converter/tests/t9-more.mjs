import { start, makePage, tagCrops, installFake, checker, dbDump, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
await installFake(page, truth);
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await page.waitForFunction(() => /lines/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 120000 });

// a save that fails once: the edit is saved by the next save
await page.evaluate(() => { const orig = window.modify; let once = true; window.modify = (store, id, fn) => (store === "docs" && once && !(once = false) ? Promise.reject(new Error("disk full (test)")) : orig(store, id, fn)); });
await page.locator(".row textarea").nth(1).fill("עריכה שנכשלה בשמירה");
await page.waitForTimeout(1200);
check("failed save tells the person", (await page.textContent(".dialog p")).includes("Couldn't save"));
await page.click(".dialog button[type=submit]");
await page.locator(".row textarea").nth(2).fill("עריכה שנייה");
await page.waitForTimeout(1200);
let db = await dbDump(page);
check("the edit from the failed save is saved with the next one", db.docs[0].pages[0].lines[1].text === "עריכה שנכשלה בשמירה" && db.docs[0].pages[0].lines[2].text === "עריכה שנייה", JSON.stringify(db.docs[0].pages[0].lines.slice(1, 3).map((l) => l.text)));

// splitting a line in the Document view doesn't teach a mismatched example
const before = db.writers[0].examples.length;
await page.click("#viewDoc"); await page.waitForSelector(".doc");
await page.evaluate(() => {
  const d = document.querySelector(".doc"); const ls = d.innerText.split("\n");
  const w = ls[3].split(" "); ls.splice(3, 1, w.slice(0, 3).join(" "), w.slice(3).join(" "));
  d.textContent = ls.join("\n"); d.dispatchEvent(new Event("input"));
});
await page.waitForTimeout(1200);
db = await dbDump(page);
check("split line not learned as an example", db.writers[0].examples.length === before, `${before} -> ${db.writers[0].examples.length}`);
await page.click("#viewLines"); await page.waitForSelector(".row textarea");

// browser Back and Forward
await page.click("#backHome");
await page.waitForSelector("#home:not([hidden])");
await page.goBack();
await page.waitForSelector("#docView:not([hidden])", { timeout: 5000 }).catch(() => {});
check("Back from the list returns to the document", await page.isVisible("#docView"));
await page.goForward();
await page.waitForSelector("#home:not([hidden])", { timeout: 5000 }).catch(() => {});
check("Forward returns to the list", await page.isVisible("#home"));
await page.goBack(); await page.goForward(); await page.goBack();
await page.waitForTimeout(1500);
check("fast Back/Forward ends on the right view", (await page.isVisible("#docView")) && page.url().includes("#doc="), page.url());
const real = errors.filter((e) => !e.includes("(test)"));
check("no page errors", real.length === 0, real.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
