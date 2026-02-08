# Fake Scanned PDF Skill Design (2026-02-08)

## Goal
Create a local Codex skill that converts a PDF into a fake scanned PDF using the existing `fakescanner.sh` pipeline.

## Decisions
- Skill name: `fake-scanned-pdf`
- Installation target: `data/.codex/skills/fake-scanned-pdf`
- Script strategy: vendored (`scripts/fakescanner.sh` copied from `~/Code/fakescanner`)
- Interface: minimal (`input.pdf [output.pdf]`)
- Advanced tunables are intentionally out of scope for v1.

## Architecture
- `SKILL.md`: trigger conditions, workflow, guardrails.
- `agents/openai.yaml`: UI metadata for discovery.
- `scripts/fakescanner.sh`: executable conversion pipeline.
- `references/requirements.md`: dependencies and troubleshooting.

## Runtime Flow
1. Receive input PDF path (and optional output path).
2. Execute vendored script.
3. Verify output exists.
4. Return output path and size.

## Error Handling
- Missing dependencies: fail fast and report install guidance.
- Missing input file: stop and request valid path.
- Non-zero exit: do not claim success.

## Validation Plan
- Script health check with `--version`.
- Ensure skill files are discoverable by local skill discovery (`bun test`).
