FROM rust:1.91-alpine AS acp-builder

WORKDIR /build

RUN apk add --no-cache build-base git make musl-dev openssl-dev pkgconfig perl
RUN git clone https://github.com/cola-io/codex-acp.git
WORKDIR /build/codex-acp
RUN cargo build --release

FROM oven/bun:1.3.6-alpine

WORKDIR /app

RUN apk add --no-cache git
COPY --from=acp-builder /build/codex-acp/target/release/codex-acp /usr/local/bin/codex-acp

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src

RUN addgroup -S agent && adduser -S agent -G agent
USER agent

ENV NODE_ENV=production
CMD ["bun", "run", "src/main.ts"]
