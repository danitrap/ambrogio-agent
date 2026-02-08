# Project Skills Bootstrap

Put versioned skills in this folder using the structure:

- `skills/<skill-id>/SKILL.md`

At startup, the ambrogio-agent bootstraps missing skills from this folder into `/data/.codex/skills`.
Existing folders in `/data/.codex/skills/<skill-id>` are never overwritten.

You can override the source path with `PROJECT_SKILLS_ROOT`.
