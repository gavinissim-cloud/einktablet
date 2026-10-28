#!/bin/sh
# Runs the converter's end-to-end tests. Needs Chromium for Playwright and Pillow (for the PDF test page).
# Usage: sh converter/tests/run.sh [WORK_DIR]
set -e
cd "$(dirname "$0")"
W=${1:-$(mktemp -d)}; mkdir -p "$W/e2e"
F="$(cd .. && pwd)/hebrew-converter.html"
# test pictures: page.png is drawn by the first test; copies for the multi-page tests
node t1-reading.mjs "$W" "$F"
for n in 1 2 3 4; do cp "$W/e2e/page.png" "$W/e2e/p$n.png"; done
python3 -c "from PIL import Image; im=Image.open('$W/e2e/page.png').convert('RGB'); im.save('$W/e2e/three.pdf', save_all=True, append_images=[im, im])"
echo '{"hello":1}' > "$W/e2e/notbackup.json"
for t in t2-editing t3-concurrency t4-errors t5-export t6-misc t8-ui t9-more; do node $t.mjs "$W" "$F"; done
if [ -n "$OLD_VERSION" ]; then node t7-upgrade.mjs "$W" "$F" "$OLD_VERSION"; fi
echo "all converter tests passed"
