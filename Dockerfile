FROM node:22-bookworm-slim

# The reading engine: Python with the CPU build of PyTorch and heb-ocr.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
COPY ocr/requirements.txt /app/ocr/requirements.txt
RUN python3 -m venv /opt/ocr \
 && /opt/ocr/bin/pip install --no-cache-dir -r /app/ocr/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu \
 && /opt/ocr/bin/pip install --no-cache-dir --no-deps "heb-ocr @ git+https://github.com/itayinbarr/heb-ocr@19b7c158d14e9293e0806f909f1d497cc4784eaf"

# The model (Mishkefet-v1, CC-BY-NC-SA-4.0) and rehearsal data, checked against fixed fingerprints.
COPY ocr/fetch_models.py /app/ocr/fetch_models.py
RUN /opt/ocr/bin/python /app/ocr/fetch_models.py /opt/models

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server ./server
COPY ocr ./ocr

# Accounts, documents, page images, learned handwriting and personal models live here.
# Mount a persistent disk at /data or they are lost on every deploy.
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 \
    OCR_PYTHON=/opt/ocr/bin/python OCR_MODELS_DIR=/opt/models
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
