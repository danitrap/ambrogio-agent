// src/cli/sync-manifest.ts
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

export type SyncManifest = {
  version: string;
  outputFile: string;
  patterns: string[];
  generator: string;
  description?: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export type SyncSkill = {
  name: string;
  skillDir: string;
  manifest: SyncManifest;
};

export function validateSyncManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Check version
  if (m.version !== "1") {
    errors.push("version must be '1'");
  }

  // Check outputFile
  if (typeof m.outputFile !== "string" || !m.outputFile) {
    errors.push("outputFile is required and must be a non-empty string");
  } else if (!path.isAbsolute(m.outputFile)) {
    errors.push("outputFile must be an absolute path");
  }

  // Check patterns
  if (!Array.isArray(m.patterns)) {
    errors.push("patterns is required and must be an array");
  } else if (m.patterns.length === 0) {
    errors.push("patterns array must not be empty");
  } else if (!m.patterns.every((p) => typeof p === "string" && p.length > 0)) {
    errors.push("patterns must be an array of non-empty strings");
  }

  // Check generator
  if (typeof m.generator !== "string" || !m.generator) {
    errors.push("generator is required and must be a non-empty string");
  }

  // Optional description
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description must be a string if provided");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function discoverSyncSkills(
  directories: string[],
): Promise<SyncSkill[]> {
  const skills: SyncSkill[] = [];

  for (const dir of directories) {
    try {
      const entries = await readdir(dir);

      for (const entry of entries) {
        const skillDir = path.join(dir, entry);

        try {
          const stats = await stat(skillDir);
          if (!stats.isDirectory()) continue;

          const syncJsonPath = path.join(skillDir, "SYNC.json");
          try {
            const content = await readFile(syncJsonPath, "utf-8");
            const manifest = JSON.parse(content);

            const validation = validateSyncManifest(manifest);
            if (!validation.valid) {
              console.warn(
                `Skipping ${entry}: invalid SYNC.json - ${validation.errors.join(", ")}`,
              );
              continue;
            }

            skills.push({
              name: entry,
              skillDir,
              manifest,
            });
          } catch (err) {
            // No SYNC.json or invalid JSON - skip silently
            continue;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Directory doesn't exist - skip
      continue;
    }
  }

  return skills;
}
