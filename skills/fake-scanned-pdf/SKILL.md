---
name: fake-scanned-pdf
description: Convert a PDF into a fake phone-scanned style PDF using the local vendored script.
---

# Fake Scanned PDF

## Use This Skill When
- The user asks to make a PDF look scanned/photocopied/noisy/skewed.

## Do Not Use This Skill When
- The input is not a PDF.
- The user requests OCR or semantic edits to content.

## Required Inputs
- Absolute input PDF path.
- Optional output path (must be under `/data/generated/scanned-pdfs/`).

## Workflow
1. Validate input file exists.
2. Choose output path under `/data/generated/scanned-pdfs/YYYY/MM/DD/` if not provided.
3. Run:
```bash
bash /data/.codex/skills/fake-scanned-pdf/scripts/fakescanner.sh "<input.pdf>" "<output.pdf>"
```
4. Verify output exists and report path + file size.
5. If asked, send via Telegram:
```bash
ambrogioctl telegram send-document --path "<output.pdf>" --json
```

## Guardrails
- Never claim success on non-zero exit.
- If dependencies are missing, report missing binaries and point to `references/requirements.md`.
- Do not write generated outputs into `/data/attachments`.
