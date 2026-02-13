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
