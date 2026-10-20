import { GoogleGenAI, ApiError, PartMediaResolutionLevel, createPartFromBase64 } from "@google/genai";

// Reading pages with Google's Gemini (paid per page; commercial use allowed on
// a paid account, where Google does not use the pages to train its models).
// Two passes: read, then proofread the draft against the image. Each request
// starts with what was learned about the writer: their corrected lines (image
// and correct text) and the words misread before.

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const PASSES = Math.min(2, Math.max(1, Number(process.env.GEMINI_PASSES || 2)));
const THINKING = process.env.GEMINI_THINKING || "HIGH"; // MINIMAL | LOW | MEDIUM | HIGH | off
const EXAMPLES = Number(process.env.GEMINI_EXAMPLES || 24); // learned lines shown per request
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT || 300) * 1000; // per request

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

let client;
// Busy (429) and server errors (5xx) are retried a few times, with growing waits.
const ai = () =>
  (client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { retryOptions: { attempts: 3 } },
  }));

export class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const LINE_SCHEMA = {
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
      },
    },
  },
  required: ["lines"],
};

export const INSTRUCTIONS = `You are an expert reader of handwritten modern Hebrew (עברית מודרנית), including cursive script (כתב יד רהוט), print-style block letters, and mixed styles, from neat to very messy, written by children, adults and the elderly, on lined, blank or squared paper, in pen or pencil, scanned or photographed at an angle.

Your job is an exact, faithful transcription of the handwriting on the page — character for character, line for line, as the writer wrote it. Accuracy matters more than anything else: look closely at every word.

Reading method:
- Work through the page line by line, top to bottom, each line right to left. A "line" is one physical line of handwriting as it appears on the page; never merge two handwritten lines or split one. Printed ruled lines of the paper are not text.
- Read every word completely, from its first letter to its last. Do not stop at a word's recognizable start, guess its ending, or drop small words, prefixes (ו ה ב כ ל מ ש) and suffixes.
- Use the surrounding words and sentence meaning to decide between letters that look alike in handwriting, especially: ו/ז/י/ן, ד/ר/ך, ה/ח/ת, ב/כ/פ, ג/נ, ט/מ, ס/ם, ע/צ/א, ק/ף, and the final forms ך ם ן ף ץ. Check each decision against the actual pen strokes — context helps you choose, but the handwriting is the authority.
- Do NOT correct the writer's spelling, grammar or word choice, and do not complete words that are not written.
- Skip text that the writer clearly crossed out. Include text inserted above a line at the place it is inserted.
- Keep niqqud only if the writer actually wrote it. Numbers and Latin-script words stay exactly as written.

Punctuation and symbols — reproduce every mark the writer made, using these characters:
- Gershayim (two short strokes in an acronym, e.g. ד״ר, צה״ל, בס״ד) → ״ ; geresh (ג׳, צ׳, מס׳) → ׳
- A short line or two lines written ABOVE letters (the handwritten way to mark an abbreviation or a number in letters) → mark them with ״ before the last letter (or ׳ after a single letter).
- Maqaf → ־ ; dashes between phrases → – ; parentheses, brackets, quotation marks, colons, semicolons, commas, periods, question and exclamation marks, slashes, percent → exactly as written. Write parentheses in reading order: "(" comes before the words it encloses.

For each line give: text; top, bottom, left, right — the line's bounding box as integers from 0 to 1000 relative to the page image's height (top/bottom) and width (left/right), generous enough for ascenders, descenders and marks above letters; unclear — the words of this line you could not read with confidence (copied exactly from your text), empty when confident.`;

function learnedParts(learning) {
  const examples = (learning?.examples || []).slice(0, EXAMPLES);
  const parts = [];
  if (examples.length) {
    parts.push({
      text: `This page was written by a writer whose handwriting has been read before. Here are ${examples.length} lines from their earlier pages, each with the correct transcription their reader confirmed. Study how this person forms each letter, joins letters, and writes final letters and punctuation, and read the new page with that in mind.`,
    });
    examples.forEach((e, i) => {
      parts.push(createPartFromBase64(e.image.toString("base64"), "image/jpeg"));
      parts.push({ text: `Example ${i + 1} — correct reading: «${e.text}»${e.ai && e.ai !== e.text ? ` (first misread as «${e.ai}»)` : ""}` });
    });
  }
  if (learning?.fixes?.length) {
    parts.push({
      text: `Words misread before in this writer's handwriting (misread → correct). Watch for the same letter shapes:\n${learning.fixes
        .slice(0, 150)
        .map((f) => `${f.from} → ${f.to}${f.count > 1 ? ` (${f.count}×)` : ""}`)
        .join("\n")}`,
    });
  }
  return parts;
}

const clamp = (n) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0)));

function cleanLine(line) {
  let [top, bottom, left, right] = [line.top, line.bottom, line.left, line.right].map(clamp);
  if (bottom < top) [top, bottom] = [bottom, top];
  if (right < left) [left, right] = [right, left];
  const text = String(line.text || "").trim();
  const words = new Set(text.split(/\s+/));
  const unclear = (Array.isArray(line.unclear) ? line.unclear : []).filter((w) => typeof w === "string" && words.has(w));
  return { text, top, bottom, left, right, unclear };
}

function googleReason(message) {
  let text = String(message || "");
  try {
    text = JSON.parse(text.slice(text.indexOf("{"))).error?.message || text;
  } catch {}
  return text.replace(/\s+/g, " ").slice(0, 400);
}

function errorFor(error) {
  if (error instanceof GeminiError) return error;
  if (error instanceof ApiError) {
    // Keep Google's own explanation (for example which quota ran out); it is shown on the page.
    const why = googleReason(error.message);
    if (error.status === 401 || error.status === 403) return new GeminiError("api_key", why);
    if (error.status === 429) return new GeminiError("rate_limited", why);
    if (error.status === 400) return new GeminiError("bad_page", why);
    return new GeminiError("api_error", `${error.status}: ${why}`);
  }
  if (/abort|timeout|timed out/i.test(`${error.name} ${error.message}`)) {
    return new GeminiError("timeout", `Gemini took longer than ${TIMEOUT_MS / 1000} seconds.`);
  }
  return new GeminiError("read_failed", error.message || "Reading failed.");
}

/** One Gemini request, given up after TIMEOUT_MS (retries included). */
async function generate(request) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiError("timeout", `Gemini took longer than ${TIMEOUT_MS / 1000} seconds.`));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      ai().models.generateContent({ ...request, config: { ...request.config, abortSignal: controller.signal } }),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ask(parts) {
  const config = {
    systemInstruction: INSTRUCTIONS,
    responseMimeType: "application/json",
    responseJsonSchema: LINE_SCHEMA,
  };
  if (THINKING !== "off") config.thinkingConfig = { thinkingLevel: THINKING };
  let response;
  try {
    response = await generate({ model: MODEL, contents: [{ role: "user", parts }], config });
  } catch (error) {
    // Some models take no thinking setting; ask once more without it.
    if (error instanceof ApiError && error.status === 400 && config.thinkingConfig && /think/i.test(error.message)) {
      delete config.thinkingConfig;
      response = await generate({ model: MODEL, contents: [{ role: "user", parts }], config });
    } else {
      throw error;
    }
  }
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(reason)) {
    throw new GeminiError(reason === "MAX_TOKENS" ? "page_too_long" : "refused", `Gemini stopped: ${reason}.`);
  }
  const text = response.text;
  if (!text) throw new GeminiError("read_failed", `Gemini gave no answer (${reason || "no reason given"}).`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GeminiError("read_failed", "Gemini's answer could not be read.");
  }
  return (data.lines || []).map(cleanLine).filter((l) => l.text);
}

/**
 * Read a page image (JPEG buffer). `learning` holds the writer's examples
 * ({image, text, ai}) and fixes ({from, to, count}). Lines come back with
 * boxes in 0–1000 page coordinates.
 */
export async function readPageGemini(image, { learning = null, onProgress = () => {} } = {}) {
  try {
    const page = createPartFromBase64(image.toString("base64"), "image/jpeg", PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH);
    const known = learnedParts(learning);
    onProgress(1, PASSES, "read");
    let lines = await ask([...known, page, { text: "Transcribe all the handwriting on this page." }]);
    if (PASSES > 1 && lines.length) {
      onProgress(2, PASSES, "check");
      const draft = lines
        .map((l, i) => `${i + 1}. [top ${l.top}, bottom ${l.bottom}, left ${l.left}, right ${l.right}] ${l.text}`)
        .join("\n");
      // If the proofread fails, the first reading is still a good result.
      const checked = await ask([
        ...known,
        page,
        {
          text: `Below is a draft transcription of this page. It may contain misread letters, words read only partly, missed or extra lines, missing punctuation (״ ׳ ־ parentheses, dashes) or inaccurate line boxes.\n\nProofread it against the handwriting: go through the image line by line and word by word, compare every word with the pen strokes, and return the corrected full transcription. Keep what the draft got right; fix everything it got wrong.\n\nDraft:\n${draft}`,
        },
      ]).catch((error) => {
        console.error("Gemini proofread failed, keeping the first reading:", error.message);
        return [];
      });
      if (checked.length) lines = checked;
    }
    return lines;
  } catch (error) {
    throw errorFor(error);
  }
}
