import { start, tagCrops, installFake, checker, dbDump, sse } from "./harness.mjs";
import fs from "node:fs";
const [S, FILE] = process.argv.slice(2);
const { browser, ctx, page, errors } = await start(FILE);
const { check, done } = checker();
check("first open asks for the key", await page.isVisible("#setup"));
// a 40-line page
const big = await page.evaluate(() => {
  const W = 2400, H = 3400, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.fillStyle = "#000"; x.font = "44px DejaVu Sans"; x.direction = "rtl"; x.textAlign = "right";
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const base = 90 + i * 82; let right = 2300; const words = [];
    const text = "זוהי שורה מספר " + "אבגדהוזחטיכלמנסעפצקרשת"[i % 22] + " של הבדיקה הגדולה";
    for (const w of text.split(" ")) { const width = x.measureText(w).width; x.fillText(w, right, base); words.push({ text: w, left: (right - width) / W * 1000, right: right / W * 1000 }); right -= width + 50; }
    lines.push({ text, top: (base - 55) / H * 1000, bottom: (base + 18) / H * 1000, left: (right + 20) / W * 1000, right: 2330 / W * 1000, words });
  }
  return { url: c.toDataURL("image/jpeg", 0.9), lines };
});
fs.writeFileSync(`${S}/e2e/big.jpg`, Buffer.from(big.url.split(",")[1], "base64"));
await tagCrops(page);
const stats = await installFake(page, big.lines, { models: ["gemini-flash-latest", "gemini-pro-latest"] });
await page.fill("#keyInput", "AQ.k"); await page.click("#keySave");
// Settings: choose Flash
await page.click("#settingsBtn");
await page.waitForFunction(() => document.querySelector("#modelPick")?.options.length >= 3);
await page.selectOption("#modelPick", "gemini-flash-latest");
await page.click(".dialog button[type=submit]");
await page.click(".dialog button[type=submit]");
await page.reload();
await tagCrops(page);
// paste an image
await page.evaluate(async () => {
  const blob = await (await fetch(document.querySelector("canvas")?.toDataURL?.() || "data:,")).blob().catch(() => null);
});
const t0 = Date.now();
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], "pasted.jpg", { type: "image/jpeg" });
  const dt = new DataTransfer(); dt.items.add(file);
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
}, fs.readFileSync(`${S}/e2e/big.jpg`).toString("base64"));
await page.waitForSelector(".dialog input"); await page.fill(".dialog input", "T"); await page.click(".dialog button[type=submit]");
await page.waitForFunction(() => /lines/.test(document.querySelector(".page-head .state")?.textContent || ""), null, { timeout: 180000 });
const secs = (Date.now() - t0) / 1000;
const texts = await page.locator(".row textarea").evaluateAll((e) => e.map((x) => x.value));
check("pasted image read", texts.length === 40);
const bad = texts.map((t, i) => [i, t, big.lines[i].text]).filter(([, a, b]) => a !== b);
check("40-line page: all lines exact", !bad.length, JSON.stringify(bad));
check("model choice kept after reopening (Flash)", stats.models.every((m) => m === "gemini-flash-latest"), [...new Set(stats.models)].join(","));
console.log(`40-line page (${stats.wordImages} word pictures, ${stats.words} word requests) handled in ${secs.toFixed(1)} s with the fake reader`);
check("40-line page is handled quickly by the converter itself", secs < 60, secs);
// phone-sized screen
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("no sideways scrolling on a phone", overflow <= 1, overflow);
await page.screenshot({ path: `${S}/e2e/phone.png` });
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(done() ? 0 : 1);
