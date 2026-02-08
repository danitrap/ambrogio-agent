import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapProjectSkills } from "../src/skills/bootstrap";

describe("bootstrapProjectSkills", () => {
  test("copies missing skills from project root into destination", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skills-bootstrap-"));
    const sourceRoot = path.join(tempRoot, "project-skills");
    const destinationRoot = path.join(tempRoot, "data-skills");

    await mkdir(path.join(sourceRoot, "alpha"), { recursive: true });
    await writeFile(path.join(sourceRoot, "alpha", "SKILL.md"), "---\nname: Alpha\n---\nAlpha body\n");

    const result = await bootstrapProjectSkills({ sourceRoot, destinationRoot });

    expect(result.copied).toEqual(["alpha"]);
    expect(result.skipped).toEqual([]);
    const copied = await readFile(path.join(destinationRoot, "alpha", "SKILL.md"), "utf8");
    expect(copied).toContain("Alpha body");
  });

  test("skips skill when destination already has that id", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skills-bootstrap-"));
    const sourceRoot = path.join(tempRoot, "project-skills");
    const destinationRoot = path.join(tempRoot, "data-skills");

    await mkdir(path.join(sourceRoot, "alpha"), { recursive: true });
    await writeFile(path.join(sourceRoot, "alpha", "SKILL.md"), "source\n");

    await mkdir(path.join(destinationRoot, "alpha"), { recursive: true });
    await writeFile(path.join(destinationRoot, "alpha", "SKILL.md"), "destination\n");

    const result = await bootstrapProjectSkills({ sourceRoot, destinationRoot });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(["alpha"]);
    const retained = await readFile(path.join(destinationRoot, "alpha", "SKILL.md"), "utf8");
    expect(retained).toBe("destination\n");
  });
});
