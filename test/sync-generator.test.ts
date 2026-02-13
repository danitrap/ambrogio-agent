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
