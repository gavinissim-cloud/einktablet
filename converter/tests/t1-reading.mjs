import { launch, makePage, tagCrops, readTag, wordsIn, sse, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx } = await launch();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("file://" + FILE);
const truth = await makePage(page, `${S}/e2e/page.png`);
await tagCrops(page);
const stats = { page: 0, words: 0, lines: 0, pick: 0, wordImages: 0 };
await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
  if (route.request().method() === "GET") return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ models: [{ name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] }] }) });
  const body = route.request().postDataJSON();
  const parts = body.contents[0].parts;
  const raw = JSON.stringify(parts.filter((p) => p.text));
  const boxes = await page.evaluate(() => window.__boxes);
  // numbered images: the inlineData right after an "Image N" label
  const numbered = [];
  parts.forEach((p, i) => { const m = p.text?.match(/^Image (\d+)/); if (m && parts[i + 1]?.inlineData) numbered.push({ n: +m[1], data: parts[i + 1].inlineData.data }); });
  if (raw.includes("ONE handwritten Hebrew word")) {
    stats.words++; stats.wordImages += numbered.length;
    const words = [];
    for (const { n, data } of numbered) {
      const id = await readTag(data); if (id < 0) throw new Error('unreadable test tag');
      const box = boxes[id];
      let text = wordsIn(truth, box).join(" ");
      if (text === "קשה") text = ""; // an empty answer
      words.push({ image: n, text, sure: true });
    }
    return route.fulfill(sse({ words }));
  }
  if (raw.includes("candidate spellings")) { stats.pick++; return route.fulfill(sse({ answers: numbered.map(({ n }) => ({ image: n, choice: "none" })) })); }
  if (raw.includes("each one handwritten line cut out of a page")) {
    stats.lines++;
    const lines = [];
    for (const { n, data } of numbered) { const box = boxes[await readTag(data)]; lines.push({ image: n, text: wordsIn(truth, { ...box, left: 0, right: 1000 }).join(" "), unclear: [] }); }
    return route.fulfill(sse({ lines }));
  }
  stats.page++;
  const fake = truth.map((l, i) => ({ text: l.text, top: Math.round(l.top), bottom: Math.round(l.bottom), left: Math.round(l.left), right: Math.round(l.right), unclear: [] }));
  fake[1].text = "שלום לכולם היום נלמד על ההיסטוריה של העיר."; // comma missed
  fake[3].text = "כשנאנס וחייב בתשלומי׳ כאילו הגיע זמן דאז של זה"; // made-up words
  fake[4].left = Math.round(truth[4].words.at(-1).right + 3); // the box cuts off the last (leftmost) word
  return route.fulfill(sse({ lines: fake }));
});
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "Tester"); await page.click(".dialog button[type=submit]");
await page.waitForFunction(() => document.querySelector(".page-head .state")?.textContent.match(/lines|Error/), null, { timeout: 60000 });
const state = await page.textContent(".page-head .state");
const got = await page.locator(".row textarea").evaluateAll((e) => e.map((x) => x.value));
const flags = await page.locator(".row").evaluateAll((rows) => rows.map((r) => r.querySelector(".flag")?.textContent || ""));
let ok = true;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); ok &&= cond; };
check("page read", /6 lines/.test(state), state);
TRUTH.forEach((t, i) => check(`line ${i + 1} exact`, got[i] === t, `got «${got[i]}»`));
check("line 2: comma difference flagged", /לכולם,/.test(flags[1]), flags[1]);
check("line 4: made-up words flagged with the other reading", /באשתו/.test(flags[3]) && /במזנותיה/.test(flags[3]) && /דבלא/.test(flags[3]), flags[3]);
check("line 4: rare spelling gets word-list suggestion", /במזונותיה/.test(flags[3]), flags[3]);
check("line 5: cut-off word kept and flagged with (remove)", /Remove «ת״ת\.»/.test(flags[4]), flags[4]);
check("line 6 read whole after an empty word answer", stats.lines >= 1, JSON.stringify(stats));
check("no page errors", errors.length === 0, errors.join("\n"));
console.log("requests:", JSON.stringify(stats));
await page.screenshot({ path: `${S}/e2e/t1.png`, fullPage: true });
await browser.close();
process.exit(ok ? 0 : 1);
