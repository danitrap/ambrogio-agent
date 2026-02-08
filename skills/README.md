# Project Skills Bootstrap

Put versioned skills in this folder using the structure:

- `skills/<skill-id>/SKILL.md`

At startup, the agent bootstraps missing skills from this folder into `/data/skills`.
Existing folders in `/data/skills/<skill-id>` are never overwritten.

You can override the source path with `PROJECT_SKILLS_ROOT`.
