import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Accuracy matters more than speed here, so default to a high effort level.
const EFFORT = process.env.CLAUDE_EFFORT || "high";
// Pass 1 reads the page; pass 2 re-reads it against the draft and fixes mistakes.
const PASSES = Math.max(1, Number(process.env.TRANSCRIBE_PASSES || 2));

export const LINE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          top: { type: "integer" },
          bottom: { type: "integer" },
          left: { type: "integer" },
          right: { type: "integer" },
          unclear: { type: "array", items: { type: "string" } },
        },
        required: ["text", "top", "bottom", "left", "right", "unclear"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export const SYSTEM = `You are an expert reader of handwritten modern Hebrew (עברית מודרנית), including cursive script (כתב יד רהוט), print-style block letters, and mixed styles, from neat to very messy, written by children, adults and the elderly, on lined, blank or squared paper, in pen or pencil, scanned or photographed at an angle.

Your job is an exact, faithful transcription of the handwriting on the page — character for character, line for line, as the writer wrote it.

Reading method:
- Work through the page line by line, top to bottom, each line right to left. A "line" is one physical line of handwriting as it appears on the page; never merge two handwritten lines or split one.
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

For each line return:
- text: the transcription of that line.
- top, bottom, left, right: the bounding box of that handwritten line, as integers from 0 to 1000 measured as a fraction of the full image height (top/bottom) and width (left/right). Make the box generous enough to contain ascenders, descenders and any marks above the letters.
- unclear: the words in this line (copied exactly from your text) that you could not read with confidence — damaged, smudged, or genuinely ambiguous. Leave it empty when you are confident.

If the image contains no handwriting, return an empty lines array.`;

function imageBlock(base64, mediaType) {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

async function callClaude(content) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: LINE_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("The model declined to read this page.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The page is too long to transcribe in one request.");
  }
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text);
  return parsed.lines.map(cleanLine).filter((l) => l.text.trim() !== "");
}

const clamp = (n) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0)));

function cleanLine(line) {
  let { top, bottom, left, right } = line;
  [top, bottom, left, right] = [top, bottom, left, right].map(clamp);
  if (bottom < top) [top, bottom] = [bottom, top];
  if (right < left) [left, right] = [right, left];
  const words = new Set(line.text.split(/\s+/));
  const unclear = (line.unclear || []).filter((w) => w && words.has(w));
  return { text: line.text.trim(), top, bottom, left, right, unclear };
}

function draftForReview(lines) {
  return lines
    .map(
      (l, i) =>
        `${i + 1}. [top ${l.top}, bottom ${l.bottom}, left ${l.left}, right ${l.right}] ${l.text}`
    )
    .join("\n");
}

/**
 * Transcribe one page image of Hebrew handwriting into lines with positions.
 * @param {string} base64 image data without the data: prefix
 * @param {string} mediaType image/jpeg | image/png | image/webp | image/gif
 */
export async function transcribePage(base64, mediaType) {
  let lines = await callClaude([
    imageBlock(base64, mediaType),
    { type: "text", text: "Transcribe all the handwriting on this page." },
  ]);

  for (let pass = 2; pass <= PASSES; pass++) {
    if (lines.length === 0) break;
    lines = await callClaude([
      imageBlock(base64, mediaType),
      {
        type: "text",
        text: `Below is a draft transcription of this page made by another reader. It may contain misread letters, wrong words, missed or extra lines, missing punctuation (״ ׳ ־ parentheses, dashes) or inaccurate line boxes.

Proofread it against the handwriting: go through the image line by line and word by word, compare every word with the pen strokes, and return the corrected full transcription. Keep what the draft got right; fix everything it got wrong.

Draft:
${draftForReview(lines)}`,
      },
    ]);
  }
  return lines;
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
