import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type SkillsBootstrapResult = {
  copied: string[];
  skipped: string[];
};

export type SkillsBootstrapOptions = {
  sourceRoot: string;
  destinationRoot: string;
};

export async function bootstrapProjectSkills(options: SkillsBootstrapOptions): Promise<SkillsBootstrapResult> {
  const { sourceRoot, destinationRoot } = options;
  const copied: string[] = [];
  const skipped: string[] = [];

  try {
    const sourceStat = await stat(sourceRoot);
    if (!sourceStat.isDirectory()) {
      return { copied, skipped };
    }
  } catch {
    return { copied, skipped };
  }

  await mkdir(destinationRoot, { recursive: true });

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceSkillPath = path.join(sourceRoot, entry.name);
    const sourceSkillFile = path.join(sourceSkillPath, "SKILL.md");
    try {
      const skillFileStat = await stat(sourceSkillFile);
      if (!skillFileStat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    const destinationSkillPath = path.join(destinationRoot, entry.name);
    try {
      const destinationStat = await stat(destinationSkillPath);
      if (destinationStat.isDirectory()) {
        skipped.push(entry.name);
        continue;
      }
    } catch {
      // Destination skill does not exist; it can be copied.
    }

    await cp(sourceSkillPath, destinationSkillPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    copied.push(entry.name);
  }

  copied.sort((a, b) => a.localeCompare(b));
  skipped.sort((a, b) => a.localeCompare(b));

  return { copied, skipped };
}
