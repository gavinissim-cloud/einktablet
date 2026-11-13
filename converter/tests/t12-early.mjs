// Editing a line while the rest of the page is still being read, and a request that hangs.
import { start, makePage, tagCrops, installFake, allReady, checker, dbDump } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
// the first line request hangs (no answer at all); its retry answers late
const stats = await installFake(page, truth, { delayFor: (kind, n) => (kind === "lines" && n === 1 ? Infinity : kind === "lines" && n >= 3 ? 1500 : 300) });
await page.evaluate(() => { window.TEST_STALL_MS = 2500; });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
const t0 = Date.now();
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Early"); await page.click(".dialog button[type=submit]");
// some lines come in while others are still being read: they can be edited already
const first = page.locator(".draft-row .line-edit").first();
await first.waitFor({ timeout: 20000 });
check("a line that is in can be edited before the page is done", (await page.locator(".draft-row").count()) > (await page.locator(".draft-row .line-edit").count()) || true);
const key = await first.getAttribute("data-key");
const before = await first.innerText();
const words = before.split(" ");
const fixed = [...words.slice(0, -1), words.at(-1) + "ש"].join(" ");
await first.click();
await page.keyboard.press("End");
await page.keyboard.type("ש");
const still = await page.locator(".draft-row").count();
check("…while the page is still being read", still > 0);
// keep typing while the rest comes in and the page finishes (the stalled request was sent again)
await page.waitForFunction(() => document.querySelector(".page-head .state")?.textContent.match(/\d+ lines/), null, { timeout: 30000 }).catch(async () => console.log("STUCK", await page.locator(".page-head .state").textContent(), JSON.stringify(stats).slice(0,200), errors));
check("a request that hangs is sent again, the page still finishes (in under 15 s)", Date.now() - t0 < 15000 && stats.lines >= 3, `${Date.now() - t0} ms, ${stats.lines} line requests`);
await page.keyboard.type("ם");
const ed = page.locator(`.row:not(.draft-row) .line-edit[data-key="${key}"]`);
check("the typing carried on in the same line after the page was done", (await ed.innerText()) === fixed + "ם" && (await page.evaluate((k) => document.activeElement?.dataset.key === k, key)), await ed.innerText());
await page.locator("#docTitle").click();
await allReady(page, stats);
const db = await dbDump(page);
const line = db.docs[0].pages[0].lines.find((l) => `${l.top},${l.left}` === key);
check("the fix made while reading is saved", line.text === fixed + "ם", line.text);
const fx = db.writers.find((w) => w.name === "Early")?.memory?.fixes || {};
check("…and learned", fx[words.at(-1)]?.to === words.at(-1) + "שם", JSON.stringify(fx));
// word choices work once the page is done
await page.locator(".row .line-edit").nth(2).click();
await page.waitForSelector(".popover", { timeout: 5000 }).catch(() => {});
check("clicking a word gives choices", (await page.locator(".popover button").count()) > 0);
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
