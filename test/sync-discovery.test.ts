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
  const first = skills.at(0);
  expect(first).toBeDefined();
  if (!first) {
    throw new Error("Expected one discovered skill");
  }
  expect(first.name).toBe("memory-manager");
  expect(first.manifest.outputFile).toBe("/data/MEMORY.md");
  expect(first.skillDir).toBe(path.join(TEST_ROOT, "memory-manager"));
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
