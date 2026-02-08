---
name: fake-scanned-pdf
description: Convert a PDF into a fake phone-scanned PDF using a vendored local script. Use when the user asks to make a PDF look scanned, photocopied, noisy, skewed, or low-quality while preserving multipage output.
---

# Fake Scanned PDF

Transform an input PDF into a "phone-scanned" looking PDF with grayscale, mild artifacts, and compression.

## Workflow

- Require an input PDF path from the user.
- Use output paths under `/data/generated/scanned-pdfs/YYYY/MM/DD/` (never write generated files into `/data/attachments`).
- Optionally accept an explicit output path from the user only if it is under `/data/generated/scanned-pdfs/`.
- Run the vendored script:

```bash
bash /data/.codex/skills/fake-scanned-pdf/scripts/fakescanner.sh "<input.pdf>" "<output.pdf>"
```

If output is omitted:

```bash
bash /data/.codex/skills/fake-scanned-pdf/scripts/fakescanner.sh "<input.pdf>"
```

- After execution, verify that the output file exists.
- Report the final output path and file size.
- Reference: il contratto runtime ufficiale per invio file su Telegram e definito nel system prompt del bridge modello.
- When conversion succeeds, include this tag in the final answer so runtime auto-sends the PDF on Telegram:

```text
<telegram_document>/data/generated/scanned-pdfs/.../file_scannerizzato.pdf</telegram_document>
```

## Guardrails

- Do not claim success if the script exits non-zero.
- If dependencies are missing, stop and report the missing binary plus install guidance from `references/requirements.md`.
- If input does not exist, stop and ask for a valid absolute path.
- Do not alter script tuning parameters in this skill; use defaults.

## Notes

- The output is rasterized and not vector-preserving.
- The script is vendored in this skill for reproducibility.
- See `references/requirements.md` for dependency installation and troubleshooting.
