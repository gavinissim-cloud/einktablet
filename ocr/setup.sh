#!/bin/sh
# Install the reading engine into .venv and download the model (about 200 MB).
set -e
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/pip install -r ocr/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install --no-deps "heb-ocr @ git+https://github.com/itayinbarr/heb-ocr@19b7c158d14e9293e0806f909f1d497cc4784eaf"
.venv/bin/python ocr/fetch_models.py models
echo "Reading engine ready."
