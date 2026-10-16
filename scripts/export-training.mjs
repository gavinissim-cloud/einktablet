// Collect corrected lines for retraining the shared reading model (on Kaggle).
//   npm run export-training [-- out-dir]
// Only accounts that allowed it (the "help improve the reading engine" setting)
// are included. Lines first read by Gemini are left out unless
// TRAIN_ON_GEMINI_LINES=1 (see README, "Training on corrections").
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sharingUserIds } from "../server/auth.js";
import * as learning from "../server/learning.js";

const out = path.resolve(process.argv[2] || "training-export");
const withGemini = process.env.TRAIN_ON_GEMINI_LINES === "1";
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, "images"), { recursive: true });

const rows = [];
const skipped = { gemini: 0, missing: 0 };
const clean = (s) => String(s ?? "").replace(/[\t\n]/g, " ");
for (const userId of await sharingUserIds()) {
  for (const writer of await learning.listWriters(userId)) {
    for (const e of await learning.listExamples(userId, writer.id)) {
      if (e.source === "gemini" && !withGemini) { skipped.gemini++; continue; }
      const name = `images/${e.id}.jpg`;
      try {
        await fs.copyFile(learning.exampleImagePath(userId, writer.id, e.id), path.join(out, name));
      } catch {
        skipped.missing++;
        continue;
      }
      rows.push([name, clean(e.text), clean(e.ai), e.source || ""].join("\t"));
    }
  }
}
await fs.writeFile(path.join(out, "lines.tsv"), rows.join("\n") + "\n");
execFileSync(process.env.OCR_PYTHON || "python3", ["-m", "zipfile", "-c", `${out}.zip`, "lines.tsv", "images"], { cwd: out });
console.log(`${rows.length} lines written to ${out}.zip` +
  (skipped.gemini ? ` (${skipped.gemini} lines first read by Gemini left out)` : ""));
