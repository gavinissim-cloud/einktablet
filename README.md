# Hebrew Handwriting to Text

A website that turns handwritten modern Hebrew (scans, phone photos or PDFs) into editable text. People sign up with a username and password; they don't need a Claude account. The site's owner provides one Anthropic API key, which pays for the reading.

- **Upload:** drag and drop, click to choose, or paste an image (Ctrl+V). Images (JPG, PNG, WebP) and multi-page PDFs.
- **Line by line:** each handwritten line is cut from the page and shown beside its typed text, so you can check and fix it line by line. Click a line's image to see it highlighted on the whole page.
- **Document view:** the full text as one editable document.
- **Words to check:** words Claude wasn't sure about are highlighted in yellow.
- **Hebrew punctuation:** gershayim (״), geresh (׳), maqaf (־), parentheses, dashes and quotes are kept. You can switch to plain keyboard punctuation (`" ' -`) when exporting.
- **Export:** Word (.docx, right-to-left), Word with the handwriting image beside each line, plain text, or copy to the clipboard.
- **Learns each person's handwriting:** see below.
- **English or Hebrew interface:** buttons and messages are in English by default. The עברית button in the top corner switches to Hebrew, and each browser remembers the choice. The transcribed text is always Hebrew, written right to left.
- **Saved automatically**, privately for each account.

## How the reading works

Each page is read three times by Claude (`claude-opus-5-5`) on the server:

1. **First reading.** Claude sees the whole page and can ask for full-resolution close-ups of any part of it (a "zoom" tool). It is told to zoom in on every word it isn't completely sure of.
2. **Line-by-line check.** Every line is cut out at full resolution and enlarged, and Claude re-reads each close-up letter by letter against the first reading. This catches word endings read only partly, look-alike letters (ו/ז/י/ן, ד/ר/ך, ה/ח/ת, ב/כ…) and missing small words.
3. **Final check.** Claude looks at the whole page again with the corrected text, zooming in to look for missing or merged lines, left-out words and punctuation.

Reading runs on the server, a few pages at a time. It keeps going if the person closes the browser, and it picks up again after a server restart. The page shows which step it is on.

Pages are uploaded at up to 4000 pixels on the long edge, so the close-ups have real detail. Photograph pages flat, well-lit and in focus: that matters more than anything else for accuracy.

## Learning each person's handwriting

Each document has a **Handwriting of** setting: the person who wrote it. Everyone starts with a profile named after their account, and can add more, for example one per student or family member.

When you correct a line, the app keeps that line's handwriting image together with your correct text, as an example for that writer. Every later reading of that writer's pages (all three passes) starts with:

- their most recent corrected lines, each shown as an image with the correct reading and what it was first misread as, and
- a list of the words misread before (`misread → correct`), counted across all their corrections.

So the more you correct someone's pages, the better their next pages are read. Each profile page shows what has been learned. You can turn learning off, or forget single examples. Changing a document's writer moves its corrections to the new writer, and reading a page again never deletes what was learned from it.

## Running it on your own computer

Requires Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start            # then open http://localhost:3000
```

To try the interface without an API key (it returns sample text instead of reading):

```bash
npm run demo
```

`npm test` checks the three-pass reading against a stand-in for Claude, so it needs no key.

## Putting it online

The app is a normal Node.js website with one folder of data, so it runs on any host that runs Node or Docker and has a **persistent disk**. Without a persistent disk, accounts and documents disappear on every deploy.

**Render (simplest):**

1. Push this repository to GitHub (it already is).
2. On [render.com](https://render.com), choose **New → Blueprint** and pick the repository. `render.yaml` sets up a web service with a 5 GB disk mounted at `/data`.
3. When asked, enter `ANTHROPIC_API_KEY` and a `SIGNUP_CODE`, which only the people you give it to can use to sign up.
4. Render gives you an `https://….onrender.com` address. You can attach your own domain in the service's settings.

**Any other host (a VPS, Railway, Fly.io…):** build the `Dockerfile`, mount a persistent volume at `/data`, set the environment variables below, and serve it over HTTPS behind the host's proxy with `TRUST_PROXY=1`.

Back up the data folder regularly. It holds everyone's accounts, documents, page images and learned handwriting.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. The key that pays for reading |
| `SIGNUP_CODE` | unset | If set, new accounts must enter this code. **Set it on a public site**, or anyone can sign up and use your API credit |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy or a host like Render (correct client IPs, secure cookies) |
| `COOKIE_SECURE` | unset | `1` to always mark the login cookie as HTTPS-only |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Accounts, documents, page images and learned handwriting |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model that reads the handwriting |
| `CLAUDE_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. Higher means more careful reading, but slower and more expensive |
| `TRANSCRIBE_PASSES` | `3` | `1` = first reading only, `2` = + line-by-line check, `3` = + final check |
| `MAX_ZOOMS` | `10` | Close-ups Claude may ask for per pass |
| `LEARNING_EXAMPLES` | `24` | Learned lines shown to Claude per request |
| `READ_CONCURRENCY` | `2` | Pages read at the same time across the whole site |
| `DEMO_MODE` | unset | `1` returns sample text without calling the API |

### Cost

Three careful passes with close-ups cost more than one quick reading. Expect very roughly **$0.50–$1.50 per page** with the default settings, more for long, dense pages. Check the actual figure in the Anthropic Console after the first few pages. To cut cost, set `TRANSCRIBE_PASSES=2` or `CLAUDE_EFFORT=medium`, and see whether the accuracy still holds on your pages.

## Accounts

- Passwords are stored only as salted scrypt hashes, in `DATA_DIR/users.json`. Logins last 30 days, using an HttpOnly cookie.
- After 10 failed logins, the account and the IP address are locked out for 15 minutes.
- There's no "forgot password" email yet. To reset a password, delete that user's entry from `users.json` and have them sign up again. Their documents stay in `DATA_DIR/docs/<user id>/` and their handwriting profiles in `DATA_DIR/writers/<user id>/`, so move both into the new account's folders.

## Limits

- iPhone HEIC photos must be converted to JPG first, since most browsers can't open HEIC.
- No handwriting reader is perfect on every hand. The yellow highlights, the side-by-side view and the learning make the remaining errors quick to find and fix.
