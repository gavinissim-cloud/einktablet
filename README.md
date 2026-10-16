# כתב יד לטקסט — Hebrew Handwriting to Text

A web app that turns handwritten modern Hebrew (scans, phone photos, or PDFs) into editable text.

- **Upload:** drag and drop, click to choose, or paste an image (Ctrl+V). Images (JPG, PNG, WebP) and multi-page PDFs.
- **Line-by-line view:** each handwritten line is cropped from the page and shown next to its typed text, so you can check and fix it line by line. Click a crop to see that line highlighted on the whole page.
- **Document view:** the full text as one editable document (Word-style).
- **Words to check:** words the reader wasn't sure about are highlighted in yellow so you know where to look.
- **Hebrew punctuation:** gershayim (״), geresh (׳), maqaf (־), parentheses, dashes, and quotes are kept. You can switch to plain keyboard punctuation (`" ' -`) when exporting.
- **English or Hebrew interface:** buttons and messages are in English by default. The עברית button in the top corner switches to Hebrew, and each browser remembers the choice. The transcribed text is always Hebrew, written right to left.
- **Accounts:** each person signs up and logs in, and sees only their own documents.
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
| `DATA_DIR` | `./data` | Folder for accounts and documents (`users.json`, `sessions.json`, and `docs/<user>/<document>/` with `doc.json` + page images). Back this folder up |
| `SIGNUP_CODE` | unset | If set, new accounts must enter this code |
| `TRUST_PROXY` | unset | `1` when running behind a reverse proxy (correct client IPs, secure cookies) |
| `COOKIE_SECURE` | unset | `1` to always mark the login cookie as HTTPS-only |
| `DEMO_MODE` | unset | `1` returns sample text without calling the API |

## Hosted preview on claude.ai

`node scripts/build-preview.mjs` builds `preview/dist/index.html`. It is the same app as a single page that runs as a claude.ai artifact, with no server of its own:

- People sign in with their claude.ai account, and each person's documents are private to them.
- Claude reads the handwriting using the viewer's own Claude usage, with the same instructions as the server.
- Page images are stored with the artifact, and Word and text files are built in the browser.

The bridge to claude.ai is `preview/backend.js`. The preview can only send Claude images of about 1.2 megapixels, so it sends each page whole plus zoomed strips. Accuracy may still differ a little from the server version.

## Accounts

Everyone signs up with a username (or email) and a password, and sees only their own documents. Reading pages and exporting also require being logged in, so strangers can't use up your API credit.

- Passwords are stored only as salted scrypt hashes, in `DATA_DIR/users.json`. Logins last 30 days, using an HttpOnly cookie.
- After 10 failed logins, the account and the IP address are locked out for 15 minutes.
- **Set `SIGNUP_CODE`** if the app is reachable from the internet. New accounts then need that code, so only people you give it to can sign up.
- Documents saved before accounts existed are moved to the first account that signs up.
- There's no "forgot password" email yet. To reset a password, delete that user's entry from `users.json` and have them sign up again. Their documents stay in `DATA_DIR/docs/<user id>/`, so move them into the new account's folder.
- Serve the app over HTTPS when it is online. Behind a proxy that handles HTTPS (nginx, Render, Fly…), set `TRUST_PROXY=1`, or set `COOKIE_SECURE=1` directly.

## Accuracy notes

- Photograph pages flat, well-lit and in focus. Resolution matters most for small or dense writing.
- Pages are sent at up to 2400px on the long edge.
- iPhone HEIC photos must be converted to JPG first, since most browsers can't open HEIC.
- No handwriting reader is perfect on every hand. Use the yellow highlights and the side-by-side view to review the result.
