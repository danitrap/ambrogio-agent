# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.6-alpine

WORKDIR /app

RUN apk add --no-cache bash ffmpeg ghostscript imagemagick git nodejs npm
RUN npm install -g @openai/codex

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY skills ./skills

RUN addgroup -S agent && adduser -S agent -G agent
USER agent

ENV NODE_ENV=production
CMD ["bun", "run", "src/main.ts"]
