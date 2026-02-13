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
