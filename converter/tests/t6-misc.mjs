import { start, makePage, tagCrops, installFake, corrupt, checker, dbDump, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
let delay = 50;
await installFake(page, truth, { pageText: corrupt, get delay() { return delay; } });
const allDone = (n) => page.waitForFunction((n) => [...document.querySelectorAll(".page-head .state")].filter((s) => s.textContent.includes("lines")).length === n, n, { timeout: 180000 });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");

// a 3-page PDF
await page.setInputFiles("#fileInput", `${S}/e2e/three.pdf`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Rivka"); await page.click(".dialog button[type=submit]");
await allDone(3);
check("3-page PDF read", (await page.locator(".page-head h3").allTextContents()).join("|").includes("page 3"));
// a correction, then move the document to another person: the learning moves too
await page.locator(".row textarea").nth(1).fill("שלום לכולם, היום נלמד!");
await page.waitForTimeout(1200);
await page.selectOption("#writerSelect", "__new");
await page.fill(".dialog input", "Moshe"); await page.click(".dialog button[type=submit]");
await page.waitForTimeout(1500);
let db = await dbDump(page);
const rivka = db.writers.find((w) => w.name === "Rivka"), moshe = db.writers.find((w) => w.name === "Moshe");
check("learning moved to the new person", (rivka.examples || []).length === 0 && moshe.examples.some((e) => e.text === "שלום לכולם, היום נלמד!"), JSON.stringify({ r: rivka.examples.length, m: moshe.examples.map((e) => e.text) }));

// backup while a page is being read
delay = 1500;
await page.setInputFiles("#fileInput", `${S}/e2e/p1.png`);
await page.waitForFunction(() => [...document.querySelectorAll(".page-head .state")].some((s) => /Step|Waiting/.test(s.textContent)));
await page.click("#backHome");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupBtn")]);
await dl.saveAs(`${S}/e2e/backup.json`);
// wrong file
await page.setInputFiles("#restoreInput", `${S}/e2e/notbackup.json`);
check("wrong file refused", (await page.textContent(".dialog p")).includes("isn't a converter backup"));
await page.click(".dialog button[type=submit]");
// delete everything, then restore
delay = 50;
await page.locator("#docList a").first().click();
await page.waitForSelector("#deleteDoc");
await page.click("#deleteDoc"); await page.click(".dialog button[type=submit]");
await page.waitForTimeout(500);
for (const name of ["Moshe", "Rivka"]) {
  await page.locator("#writerList a", { hasText: name }).click();
  await page.waitForSelector("#writerView:not([hidden])");
  await page.click("#writerDelete"); await page.click(".dialog button[type=submit]");
  await page.waitForTimeout(400);
}
db = await dbDump(page);
check("everything deleted", db.docs.length === 0 && db.writers.length === 0);
await page.setInputFiles("#restoreInput", `${S}/e2e/backup.json`);
await page.click(".dialog button[type=submit]"); // confirm
await page.waitForTimeout(800);
await page.click(".dialog button[type=submit]"); // "Restored."
await page.locator("#docList a").first().click();
await allDone(4);
db = await dbDump(page);
check("restored: 4 pages, all read (the one mid-reading too)", db.docs[0].pages.length === 4 && db.docs[0].pages.every((p) => p.status === "done"), db.docs[0].pages.map((p) => p.status).join(","));
check("restored: corrections and learning back", db.docs[0].pages[0].lines[1].text === "שלום לכולם, היום נלמד!" && db.writers.find((w) => w.name === "Moshe")?.examples.length >= 1);

// remove a page and delete a document while they are being read: no errors, nothing comes back
delay = 1500;
await page.setInputFiles("#fileInput", `${S}/e2e/p2.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 5);
await page.locator(".page-head").nth(4).locator("button", { hasText: "Remove" }).click();
await page.click(".dialog button[type=submit]");
await page.waitForTimeout(6000);
db = await dbDump(page);
check("page removed while reading stays removed", db.docs[0].pages.length === 4, db.docs[0].pages.length);
await page.setInputFiles("#fileInput", `${S}/e2e/p3.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 5);
await page.click("#deleteDoc"); await page.click(".dialog button[type=submit]");
await page.waitForTimeout(8000);
db = await dbDump(page);
check("document deleted while reading stays deleted", db.docs.length === 0, db.docs.length);
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
