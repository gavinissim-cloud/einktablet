import { start, makePage, tagCrops, installFake, corruptLines, settled, checker, dbDump, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
await installFake(page, truth, { lineText: (t) => (t.startsWith("הקנס") ? t + " נוסף" : corruptLines(t)) });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await settled(page);
const texts = () => page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
const save = () => page.waitForTimeout(1500);

// 1. One-click choice replaces exactly that whole word
await page.locator(".row").nth(3).locator(".choice-group", { hasText: "באשתו" }).locator("button.alt").first().click();
let t = await texts();
check("choice replaced only that word", t[3] === TRUTH[3].replace("באשתו", "כשנאנס"), t[3]);
// 2. Remove choice
await page.locator(".row").nth(4).locator(".choice-group", { hasText: "נוסף" }).locator("button.alt", { hasText: "✕" }).click();
t = await texts();
check("remove choice removed the extra word", t[4] === TRUTH[4], t[4]);
// 3. Typing a correction
await page.locator(".row .line-edit").nth(1).fill("שלום לכולם, היום נלמד על ההיסטוריה של העיר!");
await save();
let db = await dbDump(page);
let lines = db.docs[0].pages[0].lines;
check("edits saved", lines[1].text.endsWith("העיר!") && lines[3].text.startsWith("כשנאנס") , JSON.stringify(lines.map((l) => l.text)));
let ex = db.writers[0].examples;
check("3 corrected lines learned", ex.length === 3, ex.map((e) => e.text).join(" | "));
check("examples have pictures", ex.every((e) => e.crop));
const box3 = JSON.stringify([lines[3].top, lines[3].bottom, lines[3].left, lines[3].right]);

// 4. Document view: delete line 3 entirely; later lines must keep their own boxes
await page.click("#viewDoc");
await page.waitForSelector(".doc");
await page.evaluate(() => {
  const d = document.querySelector(".doc");
  const ls = d.innerText.split("\n"); ls.splice(2, 1);
  d.textContent = ls.join("\n");
  d.dispatchEvent(new Event("input"));
});
await save();
db = await dbDump(page);
lines = db.docs[0].pages[0].lines;
check("doc view: 5 lines left", lines.length === 5, lines.length);
check("doc view: the line after the deleted one kept its own box", JSON.stringify([lines[2].top, lines[2].bottom, lines[2].left, lines[2].right]) === box3, JSON.stringify(lines[2]));
ex = db.writers[0].examples;
check("doc view: learned examples unchanged and matched to their lines", ex.length === 3 && ex.some((e) => e.text.startsWith("כשנאנס")), ex.map((e) => e.text).join(" | "));
await page.click("#viewLines");
await page.waitForSelector(".row .line-edit");
t = await texts();
check("lines view after doc edit", t.length === 5 && t[2].startsWith("כשנאנס"), JSON.stringify(t));

// 5. Forget sticks
await page.click("#backHome");
await page.locator("#writerList a").first().click();
await page.waitForSelector("#writerView:not([hidden])");
const before = await page.locator(".example").count();
await page.locator(".example button", { hasText: "Forget" }).first().click();
await page.waitForTimeout(500);
await page.click("#writerBack");
await page.locator("#docList a").first().click();
await page.waitForSelector(".row .line-edit");
await page.locator(".row .line-edit").nth(0).fill("בס״ד!"); // any edit triggers a save of the page
await save();
db = await dbDump(page);
check("forgotten example not learned again", db.writers[0].examples.length === before, `${before} -> ${db.writers[0].examples.length} (now ${db.writers[0].examples.map((e) => e.text).join(" | ")})`);

// 6. Reload keeps everything
await page.reload();
await page.waitForSelector(".row .line-edit");
t = await texts();
check("after reload the edits are there", t[0] === "בס״ד!" && t.length === 5, JSON.stringify(t));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
