# Debian slim base. The render worker uses the distro Chromium via
# puppeteer-core (no Chromium download at npm install time), so we install the
# `chromium` package + fonts here. The same image runs both api and worker;
# api doesn't use Chromium but sharing one image keeps the build simple.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-core \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# fonts-noto-core: Indic and other non-Latin scripts (locale fixtures) render
# with real glyphs instead of fallback boxes.

# puppeteer-core launches this binary (matches config default / .env CHROMIUM_PATH).
ENV CHROMIUM_PATH=/usr/bin/chromium

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
