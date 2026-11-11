import { start, makePage, tagCrops, installFake, settled, checker, dbDump, sse, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { check, done } = checker();

async function run(name, fakeOpts, extra = {}) {
  const { browser, page, errors } = await start(FILE);
  const truth = await makePage(page, `${S}/e2e/page.png`);
  await tagCrops(page);
  const stats = await installFake(page, truth, fakeOpts);
  if (extra.careful) await page.evaluate(() => localStorage.setItem("read_mode", "careful"));
  if (extra.before) await extra.before(page, truth);
  await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
  await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
  await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
  await page.waitForFunction(() => { const t = document.querySelector(".page-head .state")?.textContent || ""; return /Error/.test(t) || (/\d+ lines/.test(t) && !/checking/.test(t)); }, null, { timeout: 180000 });
  const state = await page.textContent(".page-head .state");
  const texts = await page.locator(".row .line-edit").evaluateAll((e) => e.map((x) => x.innerText));
  await browser.close();
  return { state, texts, stats, errors };
}

let r = await run("busy", { fail: (k, n) => (k === "lines" && n === 1 ? { status: 429, message: "Resource exhausted, try later" } : null) });
check("Google busy once: retried and read", /6 lines/.test(r.state) && r.stats.lines === 3, r.state + JSON.stringify(r.stats));

r = await run("bad key", { fail: () => ({ status: 400, message: "API key not valid. Please pass a valid API key." }) });
check("wrong key: clear message", /key isn't accepted/.test(r.state), r.state);

r = await run("fast", { models: ["gemini-flash-latest", "gemini-pro-latest", "gemini-2.5-pro"] });
check("Fast (default) reads with Flash", r.stats.models.every((m) => m === "gemini-flash-latest") && /6 lines/.test(r.state), r.stats.models.join(","));
r = await run("auto pro", { models: ["gemini-flash-latest", "gemini-pro-latest", "gemini-2.5-pro"] }, { careful: true });
check("Most careful picks the best Pro model", r.stats.models[0] === "gemini-pro-latest" && /6 lines/.test(r.state), r.stats.models.join(","));

r = await run("pro missing", { models: ["gemini-flash-latest", "gemini-pro-latest"], fail: (k, n, url) => (url.includes("pro") ? { status: 404, message: "models/gemini-pro-latest is not found" } : null) }, { careful: true });
check("Pro not available: falls back to Flash and reads", /6 lines/.test(r.state) && r.stats.models.includes("gemini-flash-latest"), r.state + " " + r.stats.models.join(","));

r = await run("pro no allowance", { models: ["gemini-flash-latest", "gemini-pro-latest"], fail: (k, n, url) => (url.includes("pro") ? { status: 429, message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-pro" } : null) }, { careful: true });
check("Pro with no allowance: falls back to Flash", /6 lines/.test(r.state), r.state);

r = await run("check down", { fail: (k) => (k === "words" || k === "pick" ? { status: 500, message: "Internal error" } : null) });
check("word check failing completely keeps the line reading", /6 lines/.test(r.state) && r.texts[1] === TRUTH[1], r.state + " " + r.texts[1]);
r = await run("lines down", { fail: (k) => (k === "lines" ? { status: 500, message: "Internal error" } : null) });
check("line reading failing: Gemini reads the whole page instead", /6 lines/.test(r.state) && r.stats.page === 1 && r.texts[1] === TRUTH[1], r.state + JSON.stringify(r.stats));
r = await run("empty line", { lineText: (t) => (t.startsWith("העיר") ? "" : t) });
check("a line answered with nothing is kept (and filled in by the word check)", r.texts.length === 6 && r.texts[2] === TRUTH[2], JSON.stringify(r.texts));

// network drop on the first request
r = await run("network", {}, { before: async (page) => {
  let dropped = false;
  await page.route("https://generativelanguage.googleapis.com/**", (route) => { if (!dropped && route.request().method() === "POST") { dropped = true; return route.abort("connectionreset"); } return route.fallback(); });
} });
check("dropped connection: retried and read", /6 lines/.test(r.state), r.state);

// an error in the middle of the answer stream, then success
r = await run("midstream", {}, { before: async (page) => {
  let once = false;
  await page.route("https://generativelanguage.googleapis.com/**", (route) => {
    if (!once && route.request().method() === "POST") { once = true; return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: 'data: {"candidates":[{"content":{"parts":[{"text":"{\\"lines\\": ["}]}}]}\r\n\r\ndata: {"error":{"code":503,"message":"The model is overloaded."}}\r\n\r\n' }); }
    return route.fallback();
  });
} });
check("error in the middle of an answer: retried and read", /6 lines/.test(r.state), r.state);

// malformed answers
r = await run("garbage", { fail: (k) => (k === "lines" ? { status: 500, message: "x" } : null), pageText: (fake) => [null, { text: "שורה\nשבורה", top: "50", bottom: 40, left: 900, right: 100 }, ...fake.slice(2)] });
const realErrors = r.errors.filter((e) => !/Failed to load resource/.test(e));
check("malformed answer handled (null entry, numbers as text, inverted box, line break)", /lines/.test(r.state) && realErrors.length === 0, r.state + realErrors.join("\n"));
await new Promise((x) => setTimeout(x, 10));
process.exit(done() ? 0 : 1);
