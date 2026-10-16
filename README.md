# כתב יד לטקסט — Hebrew Handwriting to Text

A web app that turns handwritten modern Hebrew (scans, phone photos, or PDFs) into editable text.

- **Upload:** drag and drop, click to choose, or paste an image (Ctrl+V). Images (JPG, PNG, WebP) and multi-page PDFs.
- **Line-by-line view:** each handwritten line is cropped from the page and shown next to its typed text, so you can check and fix it line by line. Click a crop to see that line highlighted on the whole page.
- **Document view:** the full text as one editable document (Word-style).
- **Words to check:** words the reader wasn't sure about are highlighted in yellow so you know where to look.
- **Hebrew punctuation:** gershayim (״), geresh (׳), maqaf (־), parentheses, dashes, and quotes are kept. You can switch to plain keyboard punctuation (`" ' -`) when exporting.
- **Saved automatically:** every document is saved on the server about a second after each edit (the top bar shows "כל השינויים נשמרו ✓"). Reloading the page or coming back later reopens it, and the home screen lists all saved documents so you can reopen, rename or delete them. If a page was still being read when the browser closed, it is read again when the document is reopened.
- **Export:** Word (.docx, right-to-left), Word with the handwriting image beside each line, plain text, or copy to clipboard.

## How the reading works

Each page goes to Claude's vision model (`claude-opus-5-5`) with instructions written for Hebrew handwriting: telling apart look-alike letters (ו/ז/י/ן, ד/ר/ך, ה/ח/ת, ב/כ…), final letters, abbreviation marks, crossed-out text, and keeping the writer's spelling unchanged.
A **second proofreading pass** then re-reads the page against the first draft and fixes mistakes. The model returns each line's text plus its position on the page, which is used to crop the handwriting for the side-by-side view.

## Running it

Requires Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start            # http://localhost:3000
```

To try the interface without an API key (returns sample text):

```bash
npm run demo
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used to read the handwriting |
| `CLAUDE_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. Higher means more careful reading, but slower and more expensive |
| `TRANSCRIBE_PASSES` | `2` | `1` = read only, `2` = read + proofread |
| `DATA_DIR` | `./data` | Folder where documents are saved (one folder per document: `doc.json` + the page images). Back this folder up to keep your documents |
| `DEMO_MODE` | unset | `1` returns sample text without calling the API |

## Saved documents and privacy

There are no user accounts yet: everyone who can open the app sees the same list of documents. Run it on your own computer or a private server, and add a login before putting it on the open internet.

## Accuracy notes

- Photograph pages flat, well-lit and in focus. Resolution matters most for small or dense writing.
- Pages are sent at up to 2400px on the long edge.
- iPhone HEIC photos must be converted to JPG first, since most browsers can't open HEIC.
- No handwriting reader is perfect on every hand. Use the yellow highlights and the side-by-side view to review the result.
