// Runs the three-pass reading against a stand-in for Claude (no API key needed):
//   node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { transcribePage } from "../server/transcribe.js";

const page = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#fff" } }).jpeg().toBuffer();

/** A fake client: each call to stream() takes the next scripted reply. */
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const reply = replies.shift();
          if (!reply) throw new Error("unexpected request");
          return { finalMessage: async () => reply };
        },
      },
    },
  };
}
const answer = (obj) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }] });
const zoom = (box) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "zoom", input: box }] });
const line = (text, top) => ({ text, top, bottom: top + 60, left: 50, right: 950, unclear: [] });

test("three passes: read with zoom, check each line, final check", async () => {
  const client = fakeClient([
    zoom({ top: 100, bottom: 200, left: 0, right: 1000 }),
    answer({ lines: [line("שלום עול", 100), line("ד״ר כהן", 300)] }),
    answer({ lines: [{ n: 1, text: "שלום עולם", unclear: [] }, { n: 2, text: "ד״ר כהן", unclear: [] }] }),
    answer({ lines: [line("שלום עולם", 100), line("ד״ר כהן", 300), line("סוף", 500)] }),
  ]);
  const steps = [];
  const lines = await transcribePage(page, { client, onProgress: (s, of) => steps.push(`${s}/${of}`) });

  assert.deepEqual(steps, ["1/3", "2/3", "3/3"]);
  assert.deepEqual(lines.map((l) => l.text), ["שלום עולם", "ד״ר כהן", "סוף"]);

  const [first, afterZoom, check, final] = client.requests;
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.tools[0].name, "zoom");
  assert.equal(first.fallbacks, "default");
  // the zoom answer is a real image, enlarged from the page
  const result = afterZoom.messages[2].content[0];
  assert.equal(result.type, "tool_result");
  const img = await sharp(Buffer.from(result.content[0].source.data, "base64")).metadata();
  assert.ok(img.width > 2000, `zoom width ${img.width}`);
  // the line check sends one close-up per line, and no tools
  assert.equal(check.tools, undefined);
  assert.equal(check.messages[0].content.filter((b) => b.type === "image").length, 2);
  assert.ok(check.messages[0].content.some((b) => b.text?.includes("first reading: «שלום עול»")));
  // the final check sees the corrected text
  assert.ok(final.messages[0].content.at(-1).text.includes("שלום עולם"));
});

test("learned examples are shown first and cached", async () => {
  const learning = {
    examples: [{ id: "e1", text: "בית", ai: "ביח", image: page }],
    fixes: ["ביח → בית"],
  };
  const client = fakeClient([answer({ lines: [] })]);
  await transcribePage(page, { client, learning });
  const content = client.requests[0].messages[0].content;
  assert.match(content[0].text, /handwriting you have read before/);
  assert.equal(content[1].type, "image");
  assert.match(content[2].text, /correct reading: «בית» \(first misread as «ביח»\)/);
  assert.match(content[3].text, /ביח → בית/);
  assert.deepEqual(content[3].cache_control, { type: "ephemeral" });
});

test("zoom limit and bad zoom input are answered as errors", async () => {
  const client = fakeClient([
    zoom({ top: "x" }),
    answer({ lines: [line("א", 10)] }),
    answer({ lines: [{ n: 1, text: "א", unclear: [] }] }),
    answer({ lines: [line("א", 10)] }),
  ]);
  await transcribePage(page, { client });
  const toolResult = client.requests[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
});
