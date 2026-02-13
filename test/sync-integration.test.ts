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
  const scriptContent = `#!/usr/bin/env bash
set -euo pipefail

# This generator creates a simple test file
output_file="$SYNC_OUTPUT_FILE"
patterns="$SYNC_PATTERNS"

echo "# Test Notes" > "$output_file"
echo "" >> "$output_file"
echo "Patterns: $patterns" >> "$output_file"
echo "" >> "$output_file"

# Simulate reading state - in real implementation would use ambrogioctl
echo "- notes:1: First note" >> "$output_file"
echo "- notes:2: Second note" >> "$output_file"

echo "Sync completed"
`;
  await writeFile(generatorScript, scriptContent);
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
