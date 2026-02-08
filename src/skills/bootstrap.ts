import { createHash } from "node:crypto";
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

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        hash.update(`dir:${relative}\n`);
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const content = await readFile(absolute);
      hash.update(`file:${relative}\n`);
      hash.update(content);
      hash.update("\n");
    }
  }

  await walk(root);
  return hash.digest("hex");
}

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

    let destinationHash = "";
    try {
      destinationHash = await hashDirectory(destinationSkillPath);
    } catch {
      destinationHash = "";
    }
    const sourceHash = await hashDirectory(sourceSkillPath);

    if (destinationHash === sourceHash) {
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
