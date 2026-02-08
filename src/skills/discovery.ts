import path from "node:path";
import { promises as fs } from "node:fs";

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  skillPath: string;
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
  private readonly skillsRoots: string[];

  constructor(skillsRoot: string | string[]) {
    this.skillsRoots = Array.isArray(skillsRoot) ? skillsRoot : [skillsRoot];
  }

  async discover(): Promise<SkillMetadata[]> {
    const skillById = new Map<string, SkillMetadata>();

    for (const skillsRoot of this.skillsRoots) {
      try {
        await fs.access(skillsRoot);
      } catch {
        continue;
      }

      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || skillById.has(entry.name)) {
          continue;
        }

        const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
        try {
          const raw = await fs.readFile(skillPath, "utf8");
          const { frontmatter, body } = parseFrontmatter(raw);
          const name = frontmatter.name ?? entry.name;
          const description = frontmatter.description ?? body.split(/\r?\n/).find(Boolean) ?? "";
          skillById.set(entry.name, {
            id: entry.name,
            name,
            description,
            skillPath,
          });
        } catch {
          continue;
        }
      }
    }

    return Array.from(skillById.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

}
