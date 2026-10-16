import Anthropic from "@anthropic-ai/sdk";
import { openPage, lineCrop } from "./images.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Accuracy matters more than speed or cost here.
const EFFORT = process.env.CLAUDE_EFFORT || "high";
// 1 = read; 2 = read + check every line close up; 3 = + final check of the whole page.
const PASSES = Math.min(3, Math.max(1, Number(process.env.TRANSCRIBE_PASSES || 3)));
const MAX_ZOOMS = Number(process.env.MAX_ZOOMS || 10); // close-ups Claude may ask for, per pass
const LINES_PER_CHECK = 10; // line close-ups per request in pass 2

let defaultClient;
const getClient = () => (defaultClient ??= new Anthropic());

const BOX = {
  top: { type: "integer" },
  bottom: { type: "integer" },
  left: { type: "integer" },
  right: { type: "integer" },
};

export const LINE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, ...BOX, unclear: { type: "array", items: { type: "string" } } },
        required: ["text", "top", "bottom", "left", "right", "unclear"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, text: { type: "string" }, unclear: { type: "array", items: { type: "string" } } },
        required: ["n", "text", "unclear"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export const SYSTEM = `You are an expert reader of handwritten modern Hebrew (עברית מודרנית), including cursive script (כתב יד רהוט), print-style block letters, and mixed styles, from neat to very messy, written by children, adults and the elderly, on lined, blank or squared paper, in pen or pencil, scanned or photographed at an angle.

Your job is an exact, faithful transcription of the handwriting on the page — character for character, line for line, as the writer wrote it. Accuracy matters more than anything else: take the time to look closely at every word.

Reading method:
- Work through the page line by line, top to bottom, each line right to left. A "line" is one physical line of handwriting as it appears on the page; never merge two handwritten lines or split one.
- Read every word completely, from its first letter to its last. Do not stop at a word's recognizable start, guess its ending, or drop small words, prefixes (ו ה ב כ ל מ ש) and suffixes.
- Use the surrounding words and sentence meaning to decide between letters that look alike in handwriting, especially: ו/ז/י/ן, ד/ר/ך, ה/ח/ת, ב/כ/פ, ג/נ, ט/מ, ס/ם, ע/צ/א, ק/ף, and the final forms ך ם ן ף ץ. Check each decision against the actual pen strokes — context helps you choose, but the handwriting is the authority.
- Do NOT correct the writer's spelling, grammar or word choice, and do not complete words that are not written. Spelling variants (כתיב מלא / חסר) stay as written.
- Skip text that the writer clearly crossed out. Include text inserted above a line (with a caret or arrow) at the place it is inserted.
- Keep niqqud (vowel points) only if the writer actually wrote them.
- Numbers, Latin-script words, email addresses and similar stay exactly as written.

Punctuation and symbols — reproduce every mark the writer made, using these Unicode characters:
- Gershayim (two short strokes, usually between the last two letters of an acronym/abbreviation, e.g. ד״ר, צה״ל, בס״ד) → ״ (U+05F4)
- Geresh (single stroke after a letter: abbreviation, number-letter, or sound change like ג׳ / צ׳ / ז׳) → ׳ (U+05F3)
- A short line or two lines written ABOVE a word or letters (the handwritten way to mark an abbreviation or a number written in letters) → transcribe the letters and mark them with ״ before the last letter (or ׳ after a single letter), as printed Hebrew does.
- Maqaf (a hyphen joining words, often written high) → ־ (U+05BE)
- Dashes between phrases → – ; parentheses ( ), brackets [ ], quotation marks, colons, semicolons, commas, periods, question and exclamation marks, slashes, ellipses, percent and other symbols → exactly as written.
- Write parentheses in logical (reading) order: the opening "(" comes before the enclosed words in the string. Unicode bidi will display it correctly.
- Bullets or list numbers at the start of a line are part of that line.

Positions: top, bottom, left and right are integers from 0 to 1000, measured as a fraction of the WHOLE page image's height (top/bottom) and width (left/right). Make a line's box generous enough to contain ascenders, descenders and any marks above the letters.

unclear: the words in a line (copied exactly from your text) that you could not read with confidence even after looking closely — damaged, smudged, or genuinely ambiguous. Leave it empty when you are confident.`;

const ZOOM_TOOL = {
  name: "zoom",
  description:
    "Shows an enlarged, full-resolution close-up of part of the page. Use it on every word or line you are not completely sure of, on small or faint writing, and to check punctuation marks (״ ׳ ־ dashes, parentheses). Give the region in the page's 0–1000 coordinates; regions of one to three lines work best.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: { ...BOX },
    required: ["top", "bottom", "left", "right"],
    additionalProperties: false,
  },
};

const jpeg = (buffer) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buffer.toString("base64") } });
const clamp = (n) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0)));

function cleanLine(line) {
  let [top, bottom, left, right] = [line.top, line.bottom, line.left, line.right].map(clamp);
  if (bottom < top) [top, bottom] = [bottom, top];
  if (right < left) [left, right] = [right, left];
  const text = String(line.text || "").trim();
  const words = new Set(text.split(/\s+/));
  const unclear = (Array.isArray(line.unclear) ? line.unclear : []).filter((w) => typeof w === "string" && w && words.has(w));
  return { text, top, bottom, left, right, unclear };
}

const numbered = (lines, withBoxes = true) =>
  lines
    .map((l, i) => `${i + 1}. ${withBoxes ? `[top ${l.top}, bottom ${l.bottom}, left ${l.left}, right ${l.right}] ` : ""}${l.text}`)
    .join("\n");

/** Content blocks describing what we learned about this writer (stable, so it is cached). */
function learningBlocks(learning) {
  if (!learning?.examples?.length) return [];
  const blocks = [
    {
      type: "text",
      text: `The page was written by a writer whose handwriting you have read before. Below are ${learning.examples.length} lines from their earlier pages, each with the correct transcription that the writer's reader confirmed. Study how this person forms each letter, joins letters, and writes final letters and punctuation, and read the new page with that in mind.`,
    },
  ];
  learning.examples.forEach((e, i) => {
    blocks.push(jpeg(e.image));
    blocks.push({ type: "text", text: `Example ${i + 1} — correct reading: «${e.text}»${e.ai && e.ai !== e.text ? ` (first misread as «${e.ai}»)` : ""}` });
  });
  if (learning.fixes?.length) {
    blocks.push({
      type: "text",
      text: `Words that were misread before in this writer's handwriting (misread → correct). Watch for the same letter shapes:\n${learning.fixes.join("\n")}`,
    });
  }
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return blocks;
}

/**
 * One request, with the zoom tool when `page` is given. Loops while Claude asks
 * for close-ups and returns the JSON answer (matching `schema`).
 */
async function ask(client, { content, schema, page }) {
  const messages = [{ role: "user", content }];
  const tools = page ? [ZOOM_TOOL] : undefined;
  let zooms = 0;
  let parseRetries = 0;

  for (let round = 0; round < MAX_ZOOMS + 4; round++) {
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        ...(tools ? { tools } : {}),
        messages,
      });
      message = await stream.finalMessage();
      parseRetries = 0;
    } catch (error) {
      // A tool input that could not be parsed at all: ask again (a few times).
      if (error instanceof Anthropic.APIError || ++parseRetries > 2) throw error;
      continue;
    }

    if (message.stop_reason === "refusal") throw new Error("The model declined to read this page.");
    if (message.stop_reason === "max_tokens") throw new Error("The page is too long to read in one request.");

    if (message.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: message.content });
      const results = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input || {};
        const valid = block.name === "zoom" && ["top", "bottom", "left", "right"].every((k) => Number.isFinite(input[k]));
        if (!valid) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: input }) });
        } else if (zooms >= MAX_ZOOMS) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "No more close-ups are available. Give your final answer now." });
        } else {
          zooms++;
          const box = cleanLine({ ...input, text: "" });
          if (box.bottom - box.top < 5) box.bottom = Math.min(1000, box.top + 5);
          if (box.right - box.left < 5) box.right = Math.min(1000, box.left + 5);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: [jpeg(await page.region(box, { maxScale: 3 })), { type: "text", text: `Close-up of top ${box.top}–${box.bottom}, left ${box.left}–${box.right}.` }],
          });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }
  throw new Error("Reading took too many steps.");
}

/**
 * Read one page of Hebrew handwriting.
 * @param {Buffer} image the stored page image
 * @param {{learning?: object, onProgress?: (step: number, of: number) => void, client?: Anthropic}} options
 */
export async function transcribePage(image, { learning = null, onProgress = () => {}, client = getClient() } = {}) {
  const page = await openPage(image);
  const whole = jpeg(await page.whole());
  const known = learningBlocks(learning);

  // Pass 1: read the page, zooming in wherever needed.
  onProgress(1, PASSES);
  let lines = (
    await ask(client, {
      page,
      schema: LINE_SCHEMA,
      content: [
        ...known,
        whole,
        { type: "text", text: "Transcribe all the handwriting on this page. Use the zoom tool on any word you are not completely sure of before you answer." },
      ],
    })
  ).lines.map(cleanLine).filter((l) => l.text);
  if (!lines.length || PASSES === 1) return lines;

  // Pass 2: check every line in a close-up of just that line.
  onProgress(2, PASSES);
  const context = numbered(lines, false);
  for (let start = 0; start < lines.length; start += LINES_PER_CHECK) {
    const batch = lines.slice(start, start + LINES_PER_CHECK);
    const content = [
      ...known,
      {
        type: "text",
        text: `A first reading of a handwritten page gave this text (for context only):\n${context}\n\nBelow are close-ups of lines ${start + 1}–${start + batch.length}, each with its first reading. Read each close-up again carefully, letter by letter, from the first letter of every word to its last. Check for misread look-alike letters, missing or extra letters, cut-off word endings, missing small words and punctuation marks. Return the correct text of each line as written, with its number n.`,
      },
    ];
    for (const [i, line] of batch.entries()) {
      content.push({ type: "text", text: `Line ${start + i + 1} — first reading: «${line.text}»` });
      content.push(jpeg(await lineCrop(page, line)));
    }
    try {
      const { lines: checked } = await ask(client, { schema: CHECK_SCHEMA, content });
      for (const c of checked) {
        const target = lines[c.n - 1];
        if (!target || c.n - 1 < start || c.n - 1 >= start + batch.length) continue;
        const fixed = cleanLine({ ...target, text: c.text, unclear: c.unclear });
        if (fixed.text) Object.assign(target, { text: fixed.text, unclear: fixed.unclear });
      }
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw error;
      console.warn("Line check failed for one batch; keeping the first reading:", error.message);
    }
  }
  if (PASSES === 2) return lines;

  // Pass 3: a final look at the whole page for anything still missing.
  onProgress(3, PASSES);
  const final = (
    await ask(client, {
      page,
      schema: LINE_SCHEMA,
      content: [
        ...known,
        whole,
        {
          type: "text",
          text: `Here is a transcription of this page. Every line has already been checked closely on its own:\n${numbered(lines)}\n\nDo a final check of the whole page against the image. Look for: lines that are missing or were merged or split, words left out, words read only partly, look-alike letters, and missing punctuation (״ ׳ ־ parentheses, dashes). Zoom in to confirm before changing anything; keep the text of a line as it is unless the close-up shows a clear error. Return the complete transcription.`,
        },
      ],
    })
  ).lines.map(cleanLine).filter((l) => l.text);
  return final.length ? final : lines;
}

/** Fake output so the interface can be tried without an API key (DEMO_MODE=1). */
export function demoPage() {
  const sample = [
    "בס״ד",
    "שלום לכולם, היום נלמד על ההיסטוריה של ת״א.",
    "העיר נוסדה בשנת 1909 (לפני יותר ממאה שנה) –",
    "והיא היום מרכז תרבותי־כלכלי חשוב.",
    "ד״ר כהן אמר: ״זו עיר שלא נחה לעולם״.",
  ];
  return sample.map((text, i) => ({
    text,
    top: 80 + i * 170,
    bottom: 80 + i * 170 + 130,
    left: 60,
    right: 940,
    unclear: i === 2 ? ["נוסדה"] : [],
  }));
}
