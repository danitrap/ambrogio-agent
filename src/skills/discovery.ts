import path from "node:path";
import { promises as fs } from "node:fs";

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  skillPath: string;
};

export type HydratedSkill = SkillMetadata & {
  instructions: string;
};

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }

  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const block = raw.slice(4, end).trim();
  const body = raw.slice(end + 5);
  const frontmatter: Record<string, string> = {};

  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

export class SkillDiscovery {
  constructor(private readonly skillsRoot: string) {}

  async discover(): Promise<SkillMetadata[]> {
    try {
      await fs.access(this.skillsRoot);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.skillsRoot, { withFileTypes: true });
    const skills: SkillMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillPath = path.join(this.skillsRoot, entry.name, "SKILL.md");
      try {
        const raw = await fs.readFile(skillPath, "utf8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const name = frontmatter.name ?? entry.name;
        const description = frontmatter.description ?? body.split(/\r?\n/).find(Boolean) ?? "";
        skills.push({
          id: entry.name,
          name,
          description,
          skillPath,
        });
      } catch {
        continue;
      }
    }

    return skills.sort((a, b) => a.id.localeCompare(b.id));
  }

  async hydrate(skill: SkillMetadata): Promise<HydratedSkill> {
    const instructions = await fs.readFile(skill.skillPath, "utf8");
    return { ...skill, instructions };
  }
}
