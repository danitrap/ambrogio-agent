import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillDiscovery } from "../src/skills/discovery";

describe("SkillDiscovery", () => {
  test("discovers skills from multiple roots and deduplicates by id", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skills-test-"));
    const dataSkills = path.join(tempRoot, "data", "skills");
    const codexSkills = path.join(tempRoot, "codex", "skills");

    await mkdir(path.join(dataSkills, "alpha"), { recursive: true });
    await mkdir(path.join(codexSkills, "beta"), { recursive: true });
    await mkdir(path.join(codexSkills, "alpha"), { recursive: true });

    await writeFile(path.join(dataSkills, "alpha", "SKILL.md"), "---\nname: Alpha\n---\nData alpha");
    await writeFile(path.join(codexSkills, "beta", "SKILL.md"), "---\nname: Beta\n---\nCodex beta");
    await writeFile(path.join(codexSkills, "alpha", "SKILL.md"), "---\nname: Alpha Codex\n---\nCodex alpha");

    const discovery = new SkillDiscovery([dataSkills, codexSkills]);
    const skills = await discovery.discover();

    expect(skills.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(skills.find((s) => s.id === "alpha")?.name).toBe("Alpha");
    expect(skills.find((s) => s.id === "beta")?.name).toBe("Beta");
  });
});
