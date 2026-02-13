# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.6

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    curl \
    ffmpeg \
    ghostscript \
    imagemagick \
    git \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    nodejs \
    npm \
    tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright && chmod 755 /ms-playwright
RUN npm install -g @openai/codex agent-browser \
  && ln -sf /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser \
  && chmod +x /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js \
  && agent-browser --version
RUN agent-browser install

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && export PATH="$HOME/.local/bin:$PATH" \
  && claude --version || echo "Claude CLI installed but needs authentication"

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY skills ./skills
COPY agents ./agents

# Create ambrogioctl wrapper script in PATH
RUN echo '#!/bin/bash\nexec bun run /app/src/cli/ambrogioctl.ts "$@"' > /usr/local/bin/ambrogioctl \
  && chmod +x /usr/local/bin/ambrogioctl

RUN groupadd --system ambrogio-agent && useradd --system --gid ambrogio-agent --create-home ambrogio-agent
USER ambrogio-agent

ENV NODE_ENV=production
ENV CLAUDE_HOME=/data/.claude
CMD ["bun", "run", "src/main.ts"]
