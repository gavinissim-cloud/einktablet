// Builds the hosted claude.ai preview: one HTML page made of public/ plus
// preview/backend.js, using the same reading instructions as the server.
// Usage: node scripts/build-preview.mjs [output.html]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM, LINE_SCHEMA } from "../server/transcribe.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const out = process.argv[2] || path.join(root, "preview", "dist", "index.html");

const html = read("public/index.html");
const body = html
  .slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
  .replace(/\s*<script src="(i18n|app)\.js"><\/script>/g, "")
  .replace('id="previewNote" data-i18n="previewNote" hidden', 'id="previewNote" data-i18n="previewNote"');
if (body.includes("<script src=")) throw new Error("public/index.html has a script the build does not inline");

// Keep "</script>" inside inlined code from closing the tag early.
const inline = (code) => code.replace(/<\/script/gi, "<\\/script");
const backend = read("preview/backend.js")
  .replace("const SYSTEM = __SYSTEM__;", () => `const SYSTEM = ${JSON.stringify(SYSTEM)};`)
  .replace("const SCHEMA = __SCHEMA__;", () => `const SCHEMA = ${JSON.stringify(LINE_SCHEMA)};`);
if (/= __(SYSTEM|SCHEMA)__;/.test(backend)) throw new Error("preview/backend.js placeholders not filled");

const page = `<title>Hebrew Handwriting to Text</title>
<style>
${read("public/styles.css")}
</style>
${body.trim()}
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.iife.js"></script>
<script>
${inline(backend)}
</script>
<script>
${inline(read("public/i18n.js"))}
</script>
<script>
${inline(read("public/app.js"))}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`Wrote ${out} (${Math.round(page.length / 1024)} KB)`);
