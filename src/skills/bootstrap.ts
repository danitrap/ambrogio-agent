import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type SkillsBootstrapResult = {
  copied: string[];
  updated: string[];
  skipped: string[];
};

export type SkillsBootstrapOptions = {
  sourceRoot: string;
  destinationRoot: string;
};

export async function bootstrapProjectSkills(options: SkillsBootstrapOptions): Promise<SkillsBootstrapResult> {
  const { sourceRoot, destinationRoot } = options;
  const copied: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  try {
    const sourceStat = await stat(sourceRoot);
    if (!sourceStat.isDirectory()) {
      return { copied, updated, skipped };
    }
  } catch {
    return { copied, updated, skipped };
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
    let destinationExists = false;
    try {
      const destinationStat = await stat(destinationSkillPath);
      if (destinationStat.isDirectory()) {
        destinationExists = true;
      }
    } catch {
      // Destination skill does not exist; it can be copied.
    }

    if (!destinationExists) {
      await cp(sourceSkillPath, destinationSkillPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      copied.push(entry.name);
      continue;
    }

    const destinationSkillFile = path.join(destinationSkillPath, "SKILL.md");
    let destinationContent = "";
    try {
      destinationContent = await readFile(destinationSkillFile, "utf8");
    } catch {
      destinationContent = "";
    }
    const sourceContent = await readFile(sourceSkillFile, "utf8");

    if (destinationContent === sourceContent) {
      skipped.push(entry.name);
      continue;
    }

    await cp(sourceSkillPath, destinationSkillPath, {
      recursive: true,
      force: true,
    });
    updated.push(entry.name);
  }

  copied.sort((a, b) => a.localeCompare(b));
  updated.sort((a, b) => a.localeCompare(b));
  skipped.sort((a, b) => a.localeCompare(b));

  return { copied, updated, skipped };
}
