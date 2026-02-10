import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export type AgentsBootstrapResult = {
  copied: boolean;
  updated: boolean;
  skipped: boolean;
};

export type AgentsBootstrapOptions = {
  sourceFile: string;
  destinationFile: string;
};

async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

export async function bootstrapAgentsFile(options: AgentsBootstrapOptions): Promise<AgentsBootstrapResult> {
  const { sourceFile, destinationFile } = options;

  try {
    const sourceStat = await stat(sourceFile);
    if (!sourceStat.isFile()) {
      return { copied: false, updated: false, skipped: false };
    }
  } catch {
    return { copied: false, updated: false, skipped: false };
  }

  const destinationDir = path.dirname(destinationFile);
  await mkdir(destinationDir, { recursive: true });

  let destinationExists = false;
  try {
    const destinationStat = await stat(destinationFile);
    if (destinationStat.isFile()) {
      destinationExists = true;
    }
  } catch {
    // Destination file does not exist; it can be copied.
  }

  if (!destinationExists) {
    await cp(sourceFile, destinationFile, {
      force: false,
      errorOnExist: true,
    });
    return { copied: true, updated: false, skipped: false };
  }

  const sourceHash = await hashFile(sourceFile);
  const destinationHash = await hashFile(destinationFile);

  if (sourceHash === destinationHash) {
    return { copied: false, updated: false, skipped: true };
  }

  await cp(sourceFile, destinationFile, {
    force: true,
  });
  return { copied: false, updated: true, skipped: false };
}
