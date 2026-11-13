// hebrew-english-converter.html must be hebrew-converter.html with only the Hebrew + English
// switches made by tools/build_mixed.py (run that after every change to hebrew-converter.html).
import fs from "node:fs";
const dir = new URL("..", import.meta.url).pathname;
const heb = fs.readFileSync(dir + "hebrew-converter.html", "utf8");
let mixed = fs.readFileSync(dir + "hebrew-english-converter.html", "utf8");
mixed = mixed.replace(/<script type="application\/octet-stream" id="lexicon-en">[^<]*<\/script>\n/, "")
  .replace("const MIXED = true;", "const MIXED = false;")
  .replace("<title>Hebrew + English Handwriting Converter</title>", "<title>Hebrew Handwriting Converter</title>")
  .replace("<h1>Hebrew + English Handwriting Converter</h1>", "<h1>Hebrew Handwriting Converter</h1>");
if (mixed !== heb) { console.log("FAIL hebrew-english-converter.html is out of date: run python3 converter/tools/build_mixed.py"); process.exit(1); }
console.log("PASS hebrew-english-converter.html is built from the current hebrew-converter.html");
