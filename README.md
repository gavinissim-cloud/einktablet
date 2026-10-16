# Hebrew Handwriting to Text

A website that turns handwritten modern Hebrew (scans, phone photos or PDFs) into editable text. People sign up with a username and password on your site; they don't need any other account.

- **Upload:** drag and drop, click to choose, or paste an image (Ctrl+V). Images (JPG, PNG, WebP) and multi-page PDFs.
- **Line by line:** each handwritten line is cut from the page and shown beside its typed text, so you can check and fix it line by line. Click a line's image to see it highlighted on the whole page.
- **Document view:** the full text as one editable document.
- **Words to check:** words the reader wasn't sure about are highlighted in yellow.
- **Hebrew punctuation:** gershayim (״), geresh (׳), maqaf (־), parentheses, dashes and quotes are kept. You can switch to plain keyboard punctuation (`" ' -`) when exporting.
- **Export:** Word (.docx, right-to-left), Word with the handwriting image beside each line, plain text, or copy to the clipboard.
- **Learns each person's handwriting** from their corrections, and trains a reading model of their own (see below).
- **English or Hebrew interface:** English by default; the עברית button switches to Hebrew. The transcribed text is always Hebrew, right to left.
- **Saved automatically**, privately for each account.

## The two readers

The app has two ways to read a page and picks the better one for each writer:

| | Gemini (Google) | The app's own engine |
|---|---|---|
| What it is | Google's Gemini model, called over the internet | A 30M-parameter handwriting model ([heb-ocr](https://github.com/itayinbarr/heb-ocr), MIT) running on your server |
| Accuracy on new handwriting | The best available: about 88% of characters right on single lines, 78% on whole pages in heb-ocr's public benchmark of real handwriting | Lower until it learns the writer: 95% of characters right on our clean test page |
| Learns the writer | Yes, from examples: each request shows it that writer's corrected lines and misread words | Yes, by training: after 20 corrected lines it trains a personal model (in our test, errors halved on a style it hadn't seen) |
| Cost | Paid per page to Google (a few cents a page at most on Flash with the defaults; check your Google billing after the first pages) | Free; uses your server's CPU |
| Commercial use | Allowed on a **paid** Google API account (on the free tier Google may use the pages to improve its products) | Allowed, with the base model trained by `ocr/train_base.ipynb` (below) |

With the default `READER=auto`:

1. Pages are read by Gemini while a writer has no personal model, or theirs isn't better yet.
2. Every correction is stored as an example. After 20 corrected lines, and again after every 25 more, the server trains that writer's personal model.
3. Training holds some lines back and compares, on lines Gemini first read, Gemini's error rate with the personal model's. When the personal model is better on at least 5 such lines, that writer's pages are read by their own model from then on: free, and the most accurate reader for them. The profile page shows the comparison.
4. If Gemini is unavailable (rate limit, outage), pages are read by the app's engine instead.

Without a Gemini key, everything is read by the app's engine.

Reading runs on the server, one page at a time. It keeps going if the person closes the browser, and picks up again after a restart. Photograph pages flat, well-lit and in focus: that matters more than anything else for accuracy.

## Learning each person's handwriting

Each document has a **Handwriting of** setting. Everyone starts with a profile named after their account and can add more, for example one per student or family member.

When you correct a line, the app keeps that line's image with your correct text as an example for that writer. Lines on a page you've reviewed and left unchanged are kept as confirmed examples too. These are used three ways:

- **Gemini** sees the writer's most recent corrected lines (image, correct text, and what was misread) and a list of words misread before.
- **The app's engine** fixes those repeated misreadings in what it reads.
- **Personal training** (above). You can start it yourself from the profile page.

You can turn learning off for a profile, or forget single examples. Changing a document's writer moves its examples to the new writer, and reading a page again never deletes what was learned.

## Setting up

Requires Node.js 20+, and Python 3.10+ for the app's engine.

```bash
npm install
npm run setup        # Python environment, the engine, and its data (a few minutes)
export GEMINI_API_KEY=...   # from https://aistudio.google.com/apikey, on a paid (billing-enabled) project
npm start            # then open http://localhost:3000
```

`npm run setup` downloads the Pinkas handwriting lines (used so personal training doesn't forget other handwriting) and builds Hebrew letter and word statistics from Wikipedia. It does not include the base model: see the next section.

To try the interface without either reader (it returns sample text):

```bash
npm run demo
```

### The base model (free, on Kaggle)

The app's engine needs a base model, `base.pt`. It has to be trained once, on a graphics card. Kaggle gives free GPU time (about 30 hours a week; no credit card, only phone verification):

1. Make a free account at [kaggle.com](https://www.kaggle.com) and verify your phone number.
2. *Create → New Notebook → File → Import Notebook*, and upload `ocr/train_base.ipynb`.
3. Follow the steps at the top of the notebook. It trains in 12-hour runs, each carrying on from the last. The whole training takes about 40 GPU hours, so with Kaggle's weekly allowance expect about two weeks.
4. Download `base.pt` from the output and put it in `models/` (or, with Docker, at `/data/models/base.pt`). Restart the server.

The notebook trains only on data that allows commercial use: DiffusionPen generated handwriting (CC-BY-4.0), HHD handwritten letters (CC-BY-3.0) and Pinkas (CC-BY-4.0).

**Not for a paid service:** the more accurate ready-made model Mishkefet-v1 is licensed CC-BY-NC-SA-4.0 (non-commercial only). For personal or research use you can get it with `python3 ocr/fetch_models.py models --noncommercial` and turn it on with `OCR_ALLOW_NONCOMMERCIAL=1`.

### Improving the shared model from users' corrections

At sign-up (and in settings), people can choose to let their corrected lines improve the reading engine for everyone. To use them:

```bash
npm run export-training      # writes training-export.zip
```

Add the zip to the Kaggle notebook as a dataset and run its last section; download the new `base.pt`.

**Lines Gemini read are left out by default.** Google's terms don't allow using Gemini's output to build a competing model, so the engine trains only on lines whose text a person typed or corrected, and on lines the app's own engine read. Gemini's readings are used only to measure. `TRAIN_ON_GEMINI_LINES=1` changes this for both personal and shared training; ask a lawyer before turning it on.

## Putting it online

The app is a normal Node.js website with one folder of data, so it runs on any host that runs Docker and has a **persistent disk**. Without one, accounts and documents disappear on every deploy.

**Render (simplest):**

1. On [render.com](https://render.com), choose **New → Blueprint** and pick this repository. `render.yaml` sets up a web service with a 5 GB disk at `/data`.
2. When asked, enter `GEMINI_API_KEY` and a `SIGNUP_CODE` (see below).
3. When `base.pt` is ready, upload it to `/data/models/base.pt` (Render's shell, or `scp` on other hosts) and restart.

**Any other host (a VPS, Railway, Fly.io…):** build the `Dockerfile`, mount a persistent volume at `/data`, set the environment variables below, and serve it over HTTPS behind the host's proxy with `TRUST_PROXY=1`. Personal training runs on the server's CPU (a few minutes per writer), so give it at least 2 CPUs and 4 GB of memory.

Back up the data folder regularly. It holds everyone's accounts, documents, page images, learned handwriting and personal models.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | unset | Turns on reading by Gemini. Use a key from a paid project |
| `READER` | `auto` | `auto` (as above), `gemini` (always Gemini), or `local` (always the app's engine) |
| `SIGNUP_CODE` | unset | If set, new accounts must enter this code. **Set it on a public site** until you add payments, or anyone can sign up and use your Gemini credit |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy or a host like Render |
| `COOKIE_SECURE` | unset | `1` to always mark the login cookie as HTTPS-only |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Accounts, documents, page images, learned handwriting |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model. A Pro model may read a little better, at several times the price |
| `GEMINI_PASSES` | `2` | `1` = read, `2` = read, then proofread against the image |
| `GEMINI_THINKING` | `HIGH` | `MINIMAL` / `LOW` / `MEDIUM` / `HIGH`, or `off` |
| `GEMINI_EXAMPLES` | `24` | Learned lines shown to Gemini per request |
| `OCR_MODELS_DIR` | `./models` (`/opt/models` in Docker) | The engine's data |
| `OCR_BASE_MODEL` | `base.pt` (`/data/models/base.pt` in Docker) | Base model file, relative to `OCR_MODELS_DIR` or a full path |
| `OCR_ALLOW_NONCOMMERCIAL` | unset | `1` lets the engine use Mishkefet-v1 when there is no `base.pt` (non-commercial use only) |
| `OCR_PYTHON` | `.venv/bin/python` | Python that runs the engine |
| `OCR_THREADS` | all cores | CPU threads for the engine |
| `TRAIN_MIN_LINES` | `20` | Corrected lines before a writer's model can be trained |
| `AUTO_TRAIN_EVERY` | `25` | New examples that start training again (`0` = only by hand) |
| `TRAIN_ON_GEMINI_LINES` | unset | `1` also trains on lines Gemini read (see above) |
| `DEMO_MODE` | unset | `1` returns sample text without reading |

## Accounts

- Passwords are stored only as salted scrypt hashes, in `DATA_DIR/users.json`. Logins last 30 days, using an HttpOnly cookie.
- After 10 failed logins, the account and the IP address are locked out for 15 minutes.
- There's no "forgot password" email yet. To reset a password, delete that user's entry from `users.json` and have them sign up again. Their documents stay in `DATA_DIR/docs/<user id>/` and their handwriting in `DATA_DIR/writers/<user id>/`, so move both into the new account's folders.
- Payments aren't built in yet.

## Limits

- iPhone HEIC photos must be converted to JPG first, since most browsers can't open HEIC.
- No reader is perfect on every hand, and the figures above come from benchmarks and test pages, not from your users' handwriting. Measure on real pages before promising a number. The yellow highlights, the side-by-side view and the learning make the remaining errors quick to find and fix.

## Credits and licences

- [heb-ocr](https://github.com/itayinbarr/heb-ocr) by Itay Inbar (MIT): the engine's model code. `ocr/build_stats.py` is adapted from its scripts.
- Training data: DiffusionPen Hebrew handwriting (CC-BY-4.0), HHD (CC-BY-3.0), Pinkas (CC-BY-4.0), Hebrew Wikipedia (CC-BY-SA), [wordfreq](https://github.com/rspeer/wordfreq) (Apache-2.0, data CC-BY-SA). CC-BY data must be credited where you list sources, for example on an "About" page.
