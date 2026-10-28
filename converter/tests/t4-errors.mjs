import { start, makePage, tagCrops, installFake, checker, dbDump, sse, TRUTH } from "./harness.mjs";
const [S, FILE] = process.argv.slice(2);
const { check, done } = checker();

async function run(name, fakeOpts, extra = {}) {
  const { browser, page, errors } = await start(FILE);
  const truth = await makePage(page, `${S}/e2e/page.png`);
  await tagCrops(page);
  const stats = await installFake(page, truth, fakeOpts);
  if (extra.before) await extra.before(page, truth);
  await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
  await page.setInputFiles("#fileInput", `${S}/e2e/page.png`);
  await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
  await page.waitForFunction(() => /lines|Error/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 120000 });
  const state = await page.textContent(".page-head .state");
  const texts = await page.locator(".row textarea").evaluateAll((e) => e.map((x) => x.value));
  await browser.close();
  return { state, texts, stats, errors };
}

let r = await run("busy", { fail: (k, n) => (k === "page" && n === 1 ? { status: 429, message: "Resource exhausted, try later" } : null) });
check("Google busy once: retried and read", /6 lines/.test(r.state) && r.stats.page === 2, r.state + JSON.stringify(r.stats));

r = await run("bad key", { fail: (k) => (k === "page" ? { status: 400, message: "API key not valid. Please pass a valid API key." } : null) });
check("wrong key: clear message", /key isn't accepted/.test(r.state) && r.stats.page === 1, r.state);

r = await run("auto pro", { models: ["gemini-flash-latest", "gemini-pro-latest", "gemini-2.5-pro"] });
check("best model chosen automatically", r.stats.models[0] === "gemini-pro-latest" && /6 lines/.test(r.state), r.stats.models.join(","));

r = await run("pro missing", { models: ["gemini-flash-latest", "gemini-pro-latest"], fail: (k, n, url) => (url.includes("pro") ? { status: 404, message: "models/gemini-pro-latest is not found" } : null) });
check("Pro not available: falls back to Flash and reads", /6 lines/.test(r.state) && r.stats.models.includes("gemini-flash-latest"), r.state + " " + r.stats.models.join(","));

r = await run("pro no allowance", { models: ["gemini-flash-latest", "gemini-pro-latest"], fail: (k, n, url) => (url.includes("pro") ? { status: 429, message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-pro" } : null) });
check("Pro with no allowance: falls back to Flash", /6 lines/.test(r.state), r.state);

r = await run("step 2 down", { fail: (k) => (k === "words" || k === "lines" || k === "pick" ? { status: 500, message: "Internal error" } : null) });
check("step 2 failing completely keeps the page reading", /6 lines/.test(r.state) && r.texts[1] === TRUTH[1], r.state + " " + r.texts[1]);

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
r = await run("garbage", { pageText: (fake) => [null, { text: "שורה\nשבורה", top: "50", bottom: 40, left: 900, right: 100 }, ...fake.slice(2)] });
check("malformed answer handled (null entry, numbers as text, inverted box, line break)", /lines/.test(r.state) && r.errors.length === 0, r.state + r.errors.join("\n"));
await new Promise((x) => setTimeout(x, 10));
process.exit(done() ? 0 : 1);
