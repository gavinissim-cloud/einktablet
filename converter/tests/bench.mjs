// Accuracy and cost on real handwriting, with the real Gemini: reads every page of the ivrit.ai
// Hebrew handwriting benchmark (huggingface.co/datasets/ivrit-ai/hebrew-handwriting-ocr-benchmark;
// gated, not stored here) in each picture quality, and compares the final text with the gold text.
// Each page gets a new writer, so nothing is learned between pages.
// Usage: node bench.mjs BENCH_DIR FILE OUT.json [modes, e.g. best,lean,best,lean] [pages, e.g. 1-10]
// BENCH_DIR holds gold.json and pages/pNN.jpg. The Gemini key is added by the network proxy.
import { start, tagCrops, installFake } from "./harness.mjs";
import fs from "node:fs";
const [DIR, FILE, OUT, MODES = "best,lean,best,lean", RANGE = "1-10"] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(`${DIR}/gold.json`, "utf8"));
const [from, to] = RANGE.split("-").map(Number);
const norm = (t) => t.replace(/״/g, '"').replace(/׳/g, "'").replace(/[־–—]/g, "-").replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim();
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const words = (t) => norm(t).split(" ").filter(Boolean);
function wordErrors(a, b) { // word-level edit distance
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
for (const [run, mode] of MODES.split(",").entries()) {
  const { browser, page, errors } = await start(FILE);
  if (process.env.DRY) { await tagCrops(page); await installFake(page, []); } // checks the test itself, no Gemini
  await page.fill("#keyInput", "proxy-injected"); await page.click("#keySave");
  await page.evaluate((m) => localStorage.setItem("picture_quality", m), mode);
  for (let n = from; n <= to; n++) {
    if (results.some((r) => r.run === run && r.mode === mode && r.page === n)) continue; // done in an earlier attempt
    const g = gold[n - 1], t0 = Date.now();
    await page.evaluate(() => { window.__autoOptionsDone = 0; });
    await page.setInputFiles("#fileInput", `${DIR}/pages/${g.file}`);
    await page.waitForSelector(".dialog input"); await page.fill(".dialog input", `Bench ${run} ${n}`); await page.click(".dialog button[type=submit]");
    await page.waitForFunction(() => /\d+ lines/.test(document.querySelector(".page-head .state")?.textContent || "") || /Error/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 15 * 60000 });
    await page.waitForFunction(() => (window.__autoOptionsDone || 0) >= 1, null, { timeout: 15 * 60000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const label = await page.locator(".page-head .state").first().textContent();
    const lines = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
    // The line reading as it was before the word-by-word check changed anything.
    const before = await page.evaluate(() => (state.doc?.pages?.[0]?.lines || []).map((l) => l.ai || ""));
    const got = norm(lines.join(" ")), want = norm(g.lines.join(" "));
    const r = { run, mode, page: n, legibility: g.legibility, seconds: Math.round((Date.now() - t0) / 1000), cents: +(label.match(/cost about ([\d.]+)¢/)?.[1] || NaN),
      chars: want.length, charErrors: lev(got, want), words: words(want).length, wordErrors: wordErrors(words(got), words(want)),
      wordErrorsBeforeCheck: wordErrors(words(before.join(" ")), words(want)), label, text: lines, before };
    results.push(r); fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    console.log(`${mode} run ${run} page ${n}: ${(100 * r.charErrors / r.chars).toFixed(1)}% characters wrong, ${r.wordErrors}/${r.words} words wrong (${r.wordErrorsBeforeCheck} before the word check), ${r.cents}¢, ${r.seconds}s`);
    await page.goto("file://" + FILE); // home, a clean page list (the documents stay in the browser)
    if (process.env.DRY) await tagCrops(page);
  }
  if (errors.length) console.log("page errors:", errors.slice(0, 5).join("\n"));
  await browser.close();
}
// Summary per mode
for (const mode of [...new Set(results.map((r) => r.mode))]) {
  const rs = results.filter((r) => r.mode === mode), sum = (k) => rs.reduce((s, r) => s + r[k], 0);
  console.log(`${mode}: ${(100 * sum("charErrors") / sum("chars")).toFixed(2)}% characters wrong, ${(100 * sum("wordErrors") / sum("words")).toFixed(2)}% words wrong (${(100 * sum("wordErrorsBeforeCheck") / sum("words")).toFixed(2)}% before the word check), ${(sum("cents") / rs.length).toFixed(1)}¢ a page on average (${rs.length} pages)`);
}
