---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user asks to open pages, fill forms, click UI elements, capture screenshots/PDFs, extract data from rendered pages, or run deterministic browser workflows.
allowed-tools: Bash(agent-browser:*)
---

# Agent Browser

## Use This Skill When
- The task requires browser interaction (open/click/fill/select/scroll).
- The user needs rendered-page extraction (not just raw HTML).
- The user asks for screenshots, PDFs, or reproducible web UI steps.

## Do Not Use This Skill When
- The request is only to fetch a static page once: use `fetch-url`.
- The task is unrelated to websites.

## Required Inputs
- Target URL.
- Goal of the interaction (submit form, extract field, capture screenshot, etc.).

## Core Workflow
1. Open page:
```bash
agent-browser open "<url>"
```
2. Capture interactive snapshot and refs:
```bash
agent-browser snapshot -i
```
3. Interact only via snapshot refs (`@e1`, `@e2`, ...):
```bash
agent-browser fill @e1 "value"
agent-browser click @e2
```
4. After each navigation/major DOM change, refresh refs:
```bash
agent-browser wait --load networkidle
agent-browser snapshot -i
```
5. Return requested artifact (text, screenshot, pdf) with explicit path/result.

## Reliable Command Set
```bash
agent-browser get url
agent-browser get title
agent-browser get text @e1
agent-browser screenshot
agent-browser screenshot --full
agent-browser pdf output.pdf
agent-browser wait @e1
agent-browser wait --url "**/target"
```

## Output Contract
- State what was done.
- Include final URL.
- Include extracted values and/or artifact path.
- If blocked by auth/CAPTCHA/2FA, report exact blocker and stop.

## Guardrails
- Never fabricate refs or results.
- Never continue using stale refs after page changes.
- Do not perform destructive account actions unless explicitly requested.
