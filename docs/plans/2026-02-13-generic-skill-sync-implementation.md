# Generic Skill Sync System Implementation Plan

**Goal:** Implement a generic sync system that allows skills to sync SQLite state to human-readable markdown files via SYNC.json manifests and custom generator scripts.

**Architecture:** Convention-based discovery system where skills declare sync config in SYNC.json, provide generator scripts, and CLI orchestrates execution. Migrate memory-manager as reference implementation.

**Tech Stack:** TypeScript (Bun), Bash scripts, SQLite (via state-store)

---

## Task 1: Add SYNC.json Schema Validation

**Files:**

- Create: `src/cli/sync-manifest.ts`
- Test: `test/sync-manifest.test.ts`

**Step 1: Write the failing test**

```typescript
// test/sync-manifest.test.ts
import { test, expect } from "bun:test";
import {
  validateSyncManifest,
  type SyncManifest,
} from "../src/cli/sync-manifest";

test("validateSyncManifest - accepts valid manifest", () => {
  const manifest: SyncManifest = {
    version: "1",
    outputFile: "/data/MEMORY.md",
    patterns: ["memory:*"],
    generator: "./scripts/sync.sh",
    description: "Test sync",
  };

  const result = validateSyncManifest(manifest);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test("validateSyncManifest - rejects missing required fields", () => {
  const manifest = {
    version: "1",
    generator: "./scripts/sync.sh",
  };

  const result = validateSyncManifest(manifest as any);
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.some((e) => e.includes("outputFile"))).toBe(true);
  expect(result.errors.some((e) => e.includes("patterns"))).toBe(true);
});

test("validateSyncManifest - rejects invalid version", () => {
  const manifest: SyncManifest = {
    version: "2",
    outputFile: "/data/MEMORY.md",
    patterns: ["memory:*"],
    generator: "./scripts/sync.sh",
  };

  const result = validateSyncManifest(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("version"))).toBe(true);
});

test("validateSyncManifest - rejects non-absolute outputFile", () => {
  const manifest: SyncManifest = {
    version: "1",
    outputFile: "MEMORY.md",
    patterns: ["memory:*"],
    generator: "./scripts/sync.sh",
  };

  const result = validateSyncManifest(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("absolute path"))).toBe(true);
});

test("validateSyncManifest - rejects empty patterns array", () => {
  const manifest: SyncManifest = {
    version: "1",
    outputFile: "/data/MEMORY.md",
    patterns: [],
    generator: "./scripts/sync.sh",
  };

  const result = validateSyncManifest(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("patterns"))).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/sync-manifest.test.ts`
Expected: FAIL with "Cannot find module '../src/cli/sync-manifest'"

**Step 3: Write minimal implementation**

```typescript
// src/cli/sync-manifest.ts
import path from "node:path";

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
```

**Step 4: Run test to verify it passes**

Run: `bun test test/sync-manifest.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add test/sync-manifest.test.ts src/cli/sync-manifest.ts
git commit -m "feat: add SYNC.json schema validation

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add Skill Discovery for Sync

**Files:**

- Modify: `src/cli/sync-manifest.ts`
- Test: `test/sync-discovery.test.ts`

**Step 1: Write the failing test**

```typescript
// test/sync-discovery.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverSyncSkills } from "../src/cli/sync-manifest";

const TEST_ROOT = path.join(import.meta.dir, "test-data-sync-discovery");

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true });

  // Create skill with SYNC.json
  const skill1Path = path.join(TEST_ROOT, "memory-manager");
  await mkdir(skill1Path, { recursive: true });
  await writeFile(
    path.join(skill1Path, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: "/data/MEMORY.md",
      patterns: ["memory:*"],
      generator: "./scripts/sync.sh",
    }),
  );

  // Create skill without SYNC.json
  const skill2Path = path.join(TEST_ROOT, "other-skill");
  await mkdir(skill2Path, { recursive: true });

  // Create skill with invalid SYNC.json
  const skill3Path = path.join(TEST_ROOT, "broken-skill");
  await mkdir(skill3Path, { recursive: true });
  await writeFile(
    path.join(skill3Path, "SYNC.json"),
    JSON.stringify({ version: "2" }),
  );
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("discoverSyncSkills - finds skills with valid SYNC.json", async () => {
  const skills = await discoverSyncSkills([TEST_ROOT]);

  expect(skills.length).toBe(1);
  expect(skills[0].name).toBe("memory-manager");
  expect(skills[0].manifest.outputFile).toBe("/data/MEMORY.md");
  expect(skills[0].skillDir).toBe(path.join(TEST_ROOT, "memory-manager"));
});

test("discoverSyncSkills - skips skills without SYNC.json", async () => {
  const skills = await discoverSyncSkills([TEST_ROOT]);

  expect(skills.every((s) => s.name !== "other-skill")).toBe(true);
});

test("discoverSyncSkills - reports invalid manifests", async () => {
  const skills = await discoverSyncSkills([TEST_ROOT]);

  const broken = skills.find((s) => s.name === "broken-skill");
  expect(broken).toBeUndefined();
});

test("discoverSyncSkills - handles multiple directories", async () => {
  const dir2 = path.join(TEST_ROOT, "skills2");
  await mkdir(dir2, { recursive: true });

  const skill4Path = path.join(dir2, "notes-manager");
  await mkdir(skill4Path, { recursive: true });
  await writeFile(
    path.join(skill4Path, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: "/data/NOTES.md",
      patterns: ["notes:*"],
      generator: "./scripts/sync.sh",
    }),
  );

  const skills = await discoverSyncSkills([TEST_ROOT, dir2]);

  expect(skills.length).toBe(2);
  expect(skills.some((s) => s.name === "memory-manager")).toBe(true);
  expect(skills.some((s) => s.name === "notes-manager")).toBe(true);

  await rm(dir2, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/sync-discovery.test.ts`
Expected: FAIL with "discoverSyncSkills is not exported"

**Step 3: Write minimal implementation**

```typescript
// Add to src/cli/sync-manifest.ts
import { readdir, readFile, stat } from "node:fs/promises";

export type SyncSkill = {
  name: string;
  skillDir: string;
  manifest: SyncManifest;
};

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
```

**Step 4: Run test to verify it passes**

Run: `bun test test/sync-discovery.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add test/sync-discovery.test.ts src/cli/sync-manifest.ts
git commit -m "feat: add skill discovery for sync manifests

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Add Generator Script Execution

**Files:**

- Modify: `src/cli/sync-manifest.ts`
- Test: `test/sync-generator.test.ts`

**Step 1: Write the failing test**

```typescript
// test/sync-generator.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { executeGenerator } from "../src/cli/sync-manifest";
import type { SyncSkill } from "../src/cli/sync-manifest";

const TEST_ROOT = path.join(import.meta.dir, "test-data-sync-generator");

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true });

  // Create skill with working generator
  const skill1Path = path.join(TEST_ROOT, "test-skill");
  await mkdir(skill1Path, { recursive: true });
  await mkdir(path.join(skill1Path, "scripts"), { recursive: true });

  const generatorScript = path.join(skill1Path, "scripts", "sync.sh");
  await writeFile(
    generatorScript,
    `#!/usr/bin/env bash
set -euo pipefail
echo "Output: $SYNC_OUTPUT_FILE" >&2
echo "Patterns: $SYNC_PATTERNS" >&2
echo "Skill Dir: $SKILL_DIR" >&2
echo "# Generated content" > "$SYNC_OUTPUT_FILE"
echo "Synced successfully"
`,
  );
  await chmod(generatorScript, 0o755);

  // Create skill with failing generator
  const skill2Path = path.join(TEST_ROOT, "broken-skill");
  await mkdir(skill2Path, { recursive: true });
  await mkdir(path.join(skill2Path, "scripts"), { recursive: true });

  const brokenScript = path.join(skill2Path, "scripts", "sync.sh");
  await writeFile(
    brokenScript,
    `#!/usr/bin/env bash
exit 1
`,
  );
  await chmod(brokenScript, 0o755);
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("executeGenerator - runs script with correct environment", async () => {
  const skill: SyncSkill = {
    name: "test-skill",
    skillDir: path.join(TEST_ROOT, "test-skill"),
    manifest: {
      version: "1",
      outputFile: path.join(TEST_ROOT, "output.md"),
      patterns: ["test:*", "foo:*"],
      generator: "./scripts/sync.sh",
    },
  };

  const result = await executeGenerator(skill);

  expect(result.success).toBe(true);
  expect(result.stdout).toContain("Synced successfully");
  expect(result.stderr).toContain(`Output: ${skill.manifest.outputFile}`);
  expect(result.stderr).toContain("Patterns: test:*,foo:*");
  expect(result.stderr).toContain(`Skill Dir: ${skill.skillDir}`);

  // Verify file was created
  const content = await readFile(skill.manifest.outputFile, "utf-8");
  expect(content).toContain("# Generated content");
});

test("executeGenerator - handles failing script", async () => {
  const skill: SyncSkill = {
    name: "broken-skill",
    skillDir: path.join(TEST_ROOT, "broken-skill"),
    manifest: {
      version: "1",
      outputFile: path.join(TEST_ROOT, "broken.md"),
      patterns: ["test:*"],
      generator: "./scripts/sync.sh",
    },
  };

  const result = await executeGenerator(skill);

  expect(result.success).toBe(false);
  expect(result.exitCode).toBe(1);
});

test("executeGenerator - handles missing generator script", async () => {
  const skill: SyncSkill = {
    name: "no-script",
    skillDir: path.join(TEST_ROOT, "test-skill"),
    manifest: {
      version: "1",
      outputFile: path.join(TEST_ROOT, "output.md"),
      patterns: ["test:*"],
      generator: "./missing.sh",
    },
  };

  const result = await executeGenerator(skill);

  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/sync-generator.test.ts`
Expected: FAIL with "executeGenerator is not exported"

**Step 3: Write minimal implementation**

```typescript
// Add to src/cli/sync-manifest.ts
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

export type GeneratorResult = {
  success: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export async function executeGenerator(
  skill: SyncSkill,
): Promise<GeneratorResult> {
  const generatorPath = path.resolve(skill.skillDir, skill.manifest.generator);

  // Check if generator exists and is executable
  try {
    await access(generatorPath, constants.X_OK);
  } catch {
    return {
      success: false,
      stdout: "",
      stderr: "",
      error: `Generator script not found or not executable: ${generatorPath}`,
    };
  }

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SYNC_OUTPUT_FILE: skill.manifest.outputFile,
      SYNC_PATTERNS: skill.manifest.patterns.join(","),
      SKILL_DIR: skill.skillDir,
    };

    const child = spawn(generatorPath, [], {
      env,
      cwd: skill.skillDir,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? undefined,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        stdout,
        stderr,
        error: err.message,
      });
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/sync-generator.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add test/sync-generator.test.ts src/cli/sync-manifest.ts
git commit -m "feat: add generator script execution with environment

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Add CLI Commands (sync list, validate)

**Files:**

- Modify: `src/cli/ambrogioctl.ts`
- Test: `test/ambrogioctl-sync.test.ts`

**Step 1: Write the failing test**

```typescript
// test/ambrogioctl-sync.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

const TEST_ROOT = path.join(import.meta.dir, "test-data-ambrogioctl-sync");
const SKILLS_DIR = path.join(TEST_ROOT, "skills");

beforeAll(async () => {
  await mkdir(SKILLS_DIR, { recursive: true });

  // Create test skill
  const skillPath = path.join(SKILLS_DIR, "test-sync");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: "/data/TEST.md",
      patterns: ["test:*"],
      generator: "./scripts/sync.sh",
      description: "Test sync skill",
    }),
  );
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("sync list - shows all skills with SYNC.json", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(["sync", "list"], {
    socketPath: "/tmp/test.sock",
    stdout: (line) => outputs.push(line),
    stderr: () => {},
    env: { SKILLS_DIRS: SKILLS_DIR },
  });

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("test-sync");
  expect(outputs.join("\n")).toContain("/data/TEST.md");
  expect(outputs.join("\n")).toContain("Test sync skill");
});

test("sync list --json - outputs JSON format", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(["sync", "list", "--json"], {
    socketPath: "/tmp/test.sock",
    stdout: (line) => outputs.push(line),
    stderr: () => {},
    env: { SKILLS_DIRS: SKILLS_DIR },
  });

  expect(exitCode).toBe(0);

  const result = JSON.parse(outputs.join(""));
  expect(result.skills).toBeArray();
  expect(result.skills.length).toBe(1);
  expect(result.skills[0].name).toBe("test-sync");
});

test("sync validate - validates specific skill", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["sync", "validate", "--skill", "test-sync"],
    {
      socketPath: "/tmp/test.sock",
      stdout: (line) => outputs.push(line),
      stderr: () => {},
      env: { SKILLS_DIRS: SKILLS_DIR },
    },
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("valid");
});

test("sync validate - fails for invalid skill", async () => {
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["sync", "validate", "--skill", "nonexistent"],
    {
      socketPath: "/tmp/test.sock",
      stdout: () => {},
      stderr: (line) => errors.push(line),
      env: { SKILLS_DIRS: SKILLS_DIR },
    },
  );

  expect(exitCode).not.toBe(0);
  expect(errors.join("\n")).toContain("not found");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/ambrogioctl-sync.test.ts`
Expected: FAIL with unknown scope or command errors

**Step 3: Write minimal implementation**

Add to `src/cli/ambrogioctl.ts` after the memory scope:

```typescript
// Add import at top
import { discoverSyncSkills, type SyncSkill } from "./sync-manifest";

// Add after memory scope (around line 980)
if (scope === "sync") {
  if (!action) {
    stderr("Usage: ambrogioctl sync <list|validate|generate> [options]");
    return 2;
  }

  const json = hasFlag(args, "--json");
  const skillsDirs = (deps.env?.SKILLS_DIRS ?? "/data/.codex/skills").split(
    ":",
  );

  if (action === "list") {
    try {
      const skills = await discoverSyncSkills(skillsDirs);

      if (json) {
        stdout(
          JSON.stringify({
            skills: skills.map((s) => ({
              name: s.name,
              outputFile: s.manifest.outputFile,
              patterns: s.manifest.patterns,
              description: s.manifest.description,
            })),
          }),
        );
      } else {
        if (skills.length === 0) {
          stdout("No skills with SYNC.json found.");
        } else {
          stdout(`Found ${skills.length} skill(s) with sync capability:\n`);
          for (const skill of skills) {
            stdout(`  ${skill.name}`);
            stdout(`    Output: ${skill.manifest.outputFile}`);
            stdout(`    Patterns: ${skill.manifest.patterns.join(", ")}`);
            if (skill.manifest.description) {
              stdout(`    Description: ${skill.manifest.description}`);
            }
            stdout("");
          }
        }
      }
      return 0;
    } catch (error) {
      stderr(`Error discovering skills: ${error}`);
      return 10;
    }
  }

  if (action === "validate") {
    const skillName = readFlag(args, "--skill");
    if (!skillName) {
      stderr("--skill is required for validate");
      return 2;
    }

    try {
      const skills = await discoverSyncSkills(skillsDirs);
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        stderr(`Skill '${skillName}' not found or has no SYNC.json`);
        return 3;
      }

      if (json) {
        stdout(JSON.stringify({ valid: true, skill: skill.name }));
      } else {
        stdout(`✓ SYNC.json for '${skillName}' is valid`);
      }
      return 0;
    } catch (error) {
      stderr(`Validation error: ${error}`);
      return 10;
    }
  }

  stderr(`Unknown sync action: ${action}`);
  return 2;
}
```

Also update RunDeps type to include env:

```typescript
// Around line 6
type RunDeps = {
  socketPath: string;
  sendRpc?: (op: string, args: Record<string, unknown>) => Promise<RpcResponse>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: Record<string, string>;
};
```

**Step 4: Run test to verify it passes**

Run: `bun test test/ambrogioctl-sync.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add test/ambrogioctl-sync.test.ts src/cli/ambrogioctl.ts
git commit -m "feat: add sync list and validate commands

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Add sync generate Command

**Files:**

- Modify: `src/cli/ambrogioctl.ts`
- Test: `test/ambrogioctl-sync-generate.test.ts`

**Step 1: Write the failing test**

```typescript
// test/ambrogioctl-sync-generate.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

const TEST_ROOT = path.join(import.meta.dir, "test-data-sync-generate");
const SKILLS_DIR = path.join(TEST_ROOT, "skills");
const OUTPUT_DIR = path.join(TEST_ROOT, "output");

beforeAll(async () => {
  await mkdir(SKILLS_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Create working skill
  const skill1Path = path.join(SKILLS_DIR, "working-skill");
  await mkdir(skill1Path, { recursive: true });
  await mkdir(path.join(skill1Path, "scripts"), { recursive: true });

  await writeFile(
    path.join(skill1Path, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: path.join(OUTPUT_DIR, "WORKING.md"),
      patterns: ["test:*"],
      generator: "./scripts/sync.sh",
    }),
  );

  const script1 = path.join(skill1Path, "scripts", "sync.sh");
  await writeFile(
    script1,
    `#!/usr/bin/env bash
set -euo pipefail
echo "# Generated by working-skill" > "$SYNC_OUTPUT_FILE"
echo "Patterns: $SYNC_PATTERNS" >> "$SYNC_OUTPUT_FILE"
echo "Synced successfully"
`,
  );
  await chmod(script1, 0o755);

  // Create failing skill
  const skill2Path = path.join(SKILLS_DIR, "failing-skill");
  await mkdir(skill2Path, { recursive: true });
  await mkdir(path.join(skill2Path, "scripts"), { recursive: true });

  await writeFile(
    path.join(skill2Path, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: path.join(OUTPUT_DIR, "FAILING.md"),
      patterns: ["fail:*"],
      generator: "./scripts/sync.sh",
    }),
  );

  const script2 = path.join(skill2Path, "scripts", "sync.sh");
  await writeFile(script2, `#!/usr/bin/env bash\nexit 1`);
  await chmod(script2, 0o755);
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("sync generate --skill - generates output file", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["sync", "generate", "--skill", "working-skill"],
    {
      socketPath: "/tmp/test.sock",
      stdout: (line) => outputs.push(line),
      stderr: () => {},
      env: { SKILLS_DIRS: SKILLS_DIR },
    },
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("Synced successfully");

  const content = await readFile(path.join(OUTPUT_DIR, "WORKING.md"), "utf-8");
  expect(content).toContain("# Generated by working-skill");
  expect(content).toContain("Patterns: test:*");
});

test("sync generate --skill - handles generator failure", async () => {
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["sync", "generate", "--skill", "failing-skill"],
    {
      socketPath: "/tmp/test.sock",
      stdout: () => {},
      stderr: (line) => errors.push(line),
      env: { SKILLS_DIRS: SKILLS_DIR },
    },
  );

  expect(exitCode).not.toBe(0);
  expect(errors.join("\n")).toContain("failed");
});

test("sync generate --all - generates for all skills", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(["sync", "generate", "--all"], {
    socketPath: "/tmp/test.sock",
    stdout: (line) => outputs.push(line),
    stderr: () => {},
    env: { SKILLS_DIRS: SKILLS_DIR },
  });

  // Should succeed even if one skill fails
  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("working-skill");
  expect(outputs.join("\n")).toContain("failing-skill");
});

test("sync generate - requires --skill or --all", async () => {
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(["sync", "generate"], {
    socketPath: "/tmp/test.sock",
    stdout: () => {},
    stderr: (line) => errors.push(line),
    env: { SKILLS_DIRS: SKILLS_DIR },
  });

  expect(exitCode).toBe(2);
  expect(errors.join("\n")).toContain("--skill or --all");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/ambrogioctl-sync-generate.test.ts`
Expected: FAIL with generate action not found

**Step 3: Write minimal implementation**

Add to sync scope in `src/cli/ambrogioctl.ts`:

```typescript
// Add import
import { executeGenerator } from "./sync-manifest";

// Add after validate action
if (action === "generate") {
  const skillName = readFlag(args, "--skill");
  const all = hasFlag(args, "--all");

  if (!skillName && !all) {
    stderr("Either --skill or --all is required for generate");
    return 2;
  }

  try {
    const skills = await discoverSyncSkills(skillsDirs);

    const toGenerate = all
      ? skills
      : skills.filter((s) => s.name === skillName);

    if (!all && toGenerate.length === 0) {
      stderr(`Skill '${skillName}' not found or has no SYNC.json`);
      return 3;
    }

    let hasErrors = false;
    const results: Array<{ skill: string; success: boolean; message: string }> =
      [];

    for (const skill of toGenerate) {
      stdout(`Generating ${skill.name}...`);
      const result = await executeGenerator(skill);

      if (result.success) {
        stdout(result.stdout);
        results.push({
          skill: skill.name,
          success: true,
          message: `Synced to ${skill.manifest.outputFile}`,
        });
      } else {
        hasErrors = true;
        stderr(
          `Failed to generate ${skill.name}: ${result.error ?? `exit code ${result.exitCode}`}`,
        );
        if (result.stderr) stderr(result.stderr);
        results.push({
          skill: skill.name,
          success: false,
          message: result.error ?? `Exit code ${result.exitCode}`,
        });
      }
    }

    if (json) {
      stdout(JSON.stringify({ results }));
    }

    // For --all, succeed even if some failed (report them but don't error)
    return all ? 0 : hasErrors ? 4 : 0;
  } catch (error) {
    stderr(`Error generating sync files: ${error}`);
    return 10;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/ambrogioctl-sync-generate.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add test/ambrogioctl-sync-generate.test.ts src/cli/ambrogioctl.ts
git commit -m "feat: add sync generate command for skills

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Migrate memory-manager Skill

**Files:**

- Create: `skills/memory-manager/SYNC.json`
- Modify: `skills/memory-manager/scripts/sync.sh`
- Modify: `skills/memory-manager/SKILL.md`

**Step 1: Create SYNC.json manifest**

```bash
cat > skills/memory-manager/SYNC.json <<'EOF'
{
  "version": "1",
  "outputFile": "/data/MEMORY.md",
  "patterns": ["memory:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs semantic memory to human-readable file"
}
EOF
```

**Step 2: Update sync.sh to use environment variables**

Original script calls `ambrogioctl memory sync`. We need to make it call the CLI with proper environment but keep backward compatibility:

```bash
#!/usr/bin/env bash
# Sync memory database to MEMORY.md file

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

# Use environment variable if set (new way), otherwise use default (old way)
OUTPUT="${SYNC_OUTPUT_FILE:-${DATA_ROOT:-/data}/MEMORY.md}"

# Parse command line args for backward compatibility
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

$AMBROGIOCTL memory sync --output "$OUTPUT"
```

**Step 3: Update SKILL.md documentation**

Edit `skills/memory-manager/SKILL.md` around line 80:

````markdown
### Sync Memory

```bash
# New way (recommended)
ambrogioctl sync generate --skill memory-manager

# Old way (still works)
./scripts/sync.sh
```
````

Regenerates `/data/MEMORY.md` from SQLite database. Run this after manual edits to the database or when you want to ensure the file is up-to-date.

````

**Step 4: Test backward compatibility**

Run: `cd skills/memory-manager && ./scripts/sync.sh`
Expected: Works as before

Run: `ambrogioctl sync generate --skill memory-manager`
Expected: Also works

**Step 5: Commit**

```bash
git add skills/memory-manager/SYNC.json skills/memory-manager/scripts/sync.sh skills/memory-manager/SKILL.md
git commit -m "feat: migrate memory-manager to generic sync system

Add SYNC.json manifest and update sync.sh to use environment
variables while maintaining backward compatibility.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
````

---

## Task 7: Add Integration Tests

**Files:**

- Create: `test/sync-integration.test.ts`

**Step 1: Write comprehensive integration test**

```typescript
// test/sync-integration.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { StateStore } from "../src/runtime/state-store";
import { startJobRpcServer } from "../src/runtime/job-rpc-server";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

const TEST_ROOT = path.join(import.meta.dir, "test-data-sync-integration");
const TEST_SOCKET = path.join(TEST_ROOT, "test.sock");
const SKILLS_DIR = path.join(TEST_ROOT, "skills");
const DATA_DIR = path.join(TEST_ROOT, "data");

let stateStore: StateStore;
let rpcHandle: { close: () => Promise<void> };

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  await mkdir(SKILLS_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  stateStore = await StateStore.open(TEST_ROOT);

  rpcHandle = await startJobRpcServer({
    socketPath: TEST_SOCKET,
    stateStore,
    retryJobDelivery: async () => "test",
    getStatus: async () => ({ test: true }),
  });

  // Create test skill that reads from state
  const skillPath = path.join(SKILLS_DIR, "test-notes");
  await mkdir(skillPath, { recursive: true });
  await mkdir(path.join(skillPath, "scripts"), { recursive: true });

  await writeFile(
    path.join(skillPath, "SYNC.json"),
    JSON.stringify({
      version: "1",
      outputFile: path.join(DATA_DIR, "NOTES.md"),
      patterns: ["notes:*"],
      generator: "./scripts/sync.sh",
    }),
  );

  const generatorScript = path.join(skillPath, "scripts", "sync.sh");
  await writeFile(
    generatorScript,
    `#!/usr/bin/env bash
set -euo pipefail

# This generator uses ambrogioctl to read state
output_file="$SYNC_OUTPUT_FILE"
patterns="$SYNC_PATTERNS"

# Get socket path from environment or use default
socket_path="\${AMBROGIO_SOCKET_PATH:-/tmp/ambrogio-agent.sock}"

echo "# Test Notes" > "$output_file"
echo "" >> "$output_file"

# List all matching entries
for pattern in \${patterns//,/ }; do
  ambrogioctl state list --pattern "$pattern" --json 2>/dev/null | \
    jq -r '.entries[]? | "- \\(.key): \\(.value)"' >> "$output_file" 2>/dev/null || true
done

echo "Sync completed"
`,
  );
  await chmod(generatorScript, 0o755);

  // Add some test data to state
  await runAmbrogioCtl(
    ["state", "set", "--key", "notes:1", "--value", "First note"],
    { socketPath: TEST_SOCKET, stdout: () => {}, stderr: () => {} },
  );

  await runAmbrogioCtl(
    ["state", "set", "--key", "notes:2", "--value", "Second note"],
    { socketPath: TEST_SOCKET, stdout: () => {}, stderr: () => {} },
  );
});

afterAll(async () => {
  await rpcHandle.close();
  stateStore.close();
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("integration - sync generate reads state and creates file", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["sync", "generate", "--skill", "test-notes"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: () => {},
      env: {
        SKILLS_DIRS: SKILLS_DIR,
        AMBROGIO_SOCKET_PATH: TEST_SOCKET,
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("Sync completed");

  const content = await readFile(path.join(DATA_DIR, "NOTES.md"), "utf-8");
  expect(content).toContain("# Test Notes");
  expect(content).toContain("notes:1");
  expect(content).toContain("notes:2");
});

test("integration - sync list shows discovered skills", async () => {
  const outputs: string[] = [];

  const exitCode = await runAmbrogioCtl(["sync", "list"], {
    socketPath: TEST_SOCKET,
    stdout: (line) => outputs.push(line),
    stderr: () => {},
    env: { SKILLS_DIRS: SKILLS_DIR },
  });

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("test-notes");
  expect(outputs.join("\n")).toContain("NOTES.md");
});
```

**Step 2: Run test to verify it passes**

Run: `bun test test/sync-integration.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add test/sync-integration.test.ts
git commit -m "test: add integration tests for sync system

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Update Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/MEMORY_SYSTEM.md`

**Step 1: Add sync section to README.md**

Add after the "Job Management" section:

````markdown
## Skill Sync System

Skills can sync their SQLite state to human-readable markdown files for auditability.

### How It Works

Skills declare sync configuration in a `SYNC.json` manifest:

```json
{
  "version": "1",
  "outputFile": "/data/MEMORY.md",
  "patterns": ["memory:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs semantic memory"
}
```
````

The generator script formats data from SQLite to markdown:

```bash
#!/usr/bin/env bash
# Environment variables provided:
# - SYNC_OUTPUT_FILE: target file path
# - SYNC_PATTERNS: comma-separated patterns
# - SKILL_DIR: skill directory path

ambrogioctl state list --pattern "$SYNC_PATTERNS" --json | \
  # ... format as markdown ...
  > "$SYNC_OUTPUT_FILE"
```

### Commands

```bash
# List skills with sync capability
ambrogioctl sync list

# Generate sync file for specific skill
ambrogioctl sync generate --skill memory-manager

# Generate for all skills
ambrogioctl sync generate --all

# Validate manifest
ambrogioctl sync validate --skill memory-manager
```

### Skills with Sync

- **memory-manager**: Syncs to `/data/MEMORY.md`

````

**Step 2: Update MEMORY_SYSTEM.md**

Update Phase 1 section to reflect the generic system:

```markdown
## Architettura

### Storage Layer

**Dual Backend:**
- **SQLite (Source of Truth)**: Tabella `runtime_kv` con pattern `memory:<type>:<id>`
- **MEMORY.md (Human Interface)**: File markdown generato da SQLite tramite generic sync system, editabile dall'utente

### Generic Sync System

Il sistema di sync è generico e riutilizzabile da qualsiasi skill:

1. Skill dichiara config in `SYNC.json`
2. Fornisce script generator personalizzato
3. CLI orchestra l'esecuzione via `ambrogioctl sync generate`

Questo permette ad altre skill (structured-notes, ecc.) di usare lo stesso pattern.
````

**Step 3: Verify changes**

Run: `cat README.md | grep -A 20 "Skill Sync System"`
Expected: Shows new section

**Step 4: Commit**

```bash
git add README.md docs/MEMORY_SYSTEM.md
git commit -m "docs: document generic skill sync system

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Run All Tests and Verify

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 2: Test memory-manager backward compatibility**

```bash
# Test old way still works
cd skills/memory-manager
./scripts/sync.sh

# Test new way
ambrogioctl sync generate --skill memory-manager
```

Expected: Both commands succeed

**Step 3: Test discovery**

Run: `ambrogioctl sync list`
Expected: Shows memory-manager (and any other skills with SYNC.json)

**Step 4: Verify generated files**

Run: `ls -la /data/*.md`
Expected: Shows MEMORY.md and any other synced files

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify all tests pass for sync system

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Post-Implementation: Enable structured-notes Sync

After the core system is implemented, adding sync to structured-notes is straightforward:

**Files to create:**

- `skills/structured-notes/SYNC.json`
- `skills/structured-notes/scripts/sync.sh`

**Example SYNC.json:**

```json
{
  "version": "1",
  "outputFile": "/data/NOTES.md",
  "patterns": ["notes:entry:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs structured notes to consolidated view"
}
```

**Example generator script:**

```bash
#!/usr/bin/env bash
set -euo pipefail

output_file="$SYNC_OUTPUT_FILE"
entries=$(ambrogioctl state list --pattern "notes:entry:*" --json)

# Format as markdown (custom logic for structured-notes)
echo "# Structured Notes" > "$output_file"
# ... custom formatting based on note type, status, etc. ...
```

This demonstrates the extensibility of the system - each skill owns its own formatting logic.
