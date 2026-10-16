FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server ./server

# Accounts, documents, page images and learned handwriting live here.
# Mount a persistent disk at /data or they are lost on every deploy.
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
