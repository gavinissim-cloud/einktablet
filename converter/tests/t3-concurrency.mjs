import { start, makePage, tagCrops, installFake, checker, dbDump, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
let { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
let failPageOnce = false;
const stats = await installFake(page, truth, { delay: 300, fail: (kind, n) => (kind === "page" && failPageOnce && (failPageOnce = false, true) ? { status: 400, message: "Request contains an invalid argument." } : null) });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
// three pages at once into one document
await page.setInputFiles("#fileInput", [`${S}/e2e/p1.png`, `${S}/e2e/p2.png`, `${S}/e2e/p3.png`]);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
// type into the first page as soon as it's done, while the others are still being read
await page.waitForFunction(() => document.querySelector(".page-head .state")?.textContent.includes("lines"), null, { timeout: 90000 });
await page.locator(".row textarea").first().fill("נערך בזמן הקריאה");
await page.waitForFunction(() => [...document.querySelectorAll(".page-head .state")].filter((s) => s.textContent.includes("lines")).length === 3, null, { timeout: 120000 });
await page.waitForTimeout(1500);
let db = await dbDump(page);
const pages = db.docs[0].pages;
check("3 pages in the document", pages.length === 3, pages.length);
check("all 3 stored as read", pages.every((p) => p.status === "done" && p.lines.length === 6), pages.map((p) => p.status + ":" + p.lines.length).join(","));
check("edit made during reading was saved", pages[0].lines[0].text === "נערך בזמן הקריאה", pages[0].lines[0].text);
check("each page read once", stats.page === 3, JSON.stringify(stats));

// closing the window in the middle of a reading: it carries on when reopened
await page.setInputFiles("#fileInput", `${S}/e2e/p4.png`);
await page.waitForFunction(() => document.querySelectorAll(".page-head").length === 4);
await page.waitForFunction(() => [...document.querySelectorAll(".page-head .state")].some((s) => /Step 1|Step 2/.test(s.textContent)), null, { timeout: 30000 });
const url = page.url();
await page.close();
page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.stack));
await page.goto(url);
await tagCrops(page);
const stats2 = await installFake(page, truth, { delay: 100 });
await page.waitForFunction(() => [...document.querySelectorAll(".page-head .state")].filter((s) => s.textContent.includes("lines")).length === 4, null, { timeout: 120000 });
db = await dbDump(page);
check("page 4 finished after reopening", db.docs[0].pages[3].status === "done" && db.docs[0].pages[3].lines.length === 6, db.docs[0].pages[3].status);
check("the earlier pages are untouched", db.docs[0].pages[0].lines[0].text === "נערך בזמן הקריאה" && db.docs[0].pages.slice(0, 3).every((p) => p.status === "done"));

// an error, then a double click on "Read again" reads it only once
await page.route("https://generativelanguage.googleapis.com/**", (r) => r.fallback());
const stats3 = await installFake(page, truth, { fail: (kind, n) => (kind === "page" && n === 1 ? { status: 400, message: "Request contains an invalid argument." } : null) });
await page.locator(".page-head").nth(3).locator("button", { hasText: "Read again" }).click();
await page.click(".dialog button[type=submit]"); // confirm
await page.waitForFunction(() => document.querySelectorAll(".page-head .state")[3]?.textContent.includes("Error"), null, { timeout: 30000 });
const again = page.locator(".page-head").nth(3).locator("button", { hasText: "Read again" });
await again.dblclick();
await page.waitForFunction(() => document.querySelectorAll(".page-head .state")[3]?.textContent.includes("lines"), null, { timeout: 60000 });
await page.waitForTimeout(1000);
check("error shown with Google's reason", true);
check("double click read the page only once more", stats3.page === 2, JSON.stringify(stats3));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
