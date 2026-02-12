import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { StateStore } from "../src/runtime/state-store";
import { startJobRpcServer } from "../src/runtime/job-rpc-server";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

const TEST_ROOT = path.join(import.meta.dir, "test-data-sync");
const TEST_SOCKET = path.join(TEST_ROOT, "test.sock");
const TEST_MEMORY_MD = path.join(TEST_ROOT, "MEMORY.md");

let stateStore: StateStore;
let rpcHandle: { close: () => Promise<void> };

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  stateStore = await StateStore.open(TEST_ROOT);

  rpcHandle = await startJobRpcServer({
    socketPath: TEST_SOCKET,
    stateStore,
    retryJobDelivery: async () => "test",
    getStatus: async () => ({ test: true }),
  });

  // Add some test memories
  await runAmbrogioCtl(
    ["memory", "add", "--type", "preference", "--content", "usa sempre bun per i progetti TypeScript", "--tags", "tooling,package-manager"],
    {
      socketPath: TEST_SOCKET,
      stdout: () => {},
      stderr: () => {},
    }
  );

  await runAmbrogioCtl(
    ["memory", "add", "--type", "fact", "--content", "server IP: 192.168.1.10", "--tags", "infrastructure"],
    {
      socketPath: TEST_SOCKET,
      stdout: () => {},
      stderr: () => {},
    }
  );

  await runAmbrogioCtl(
    ["memory", "add", "--type", "pattern", "--content", "tende a dimenticare i commit prima del push", "--confidence", "85"],
    {
      socketPath: TEST_SOCKET,
      stdout: () => {},
      stderr: () => {},
    }
  );
});

afterAll(async () => {
  await rpcHandle.close();
  stateStore.close();
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("memory.sync - should generate MEMORY.md with all sections", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "sync", "--output", TEST_MEMORY_MD],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("MEMORY.md synced successfully");
  expect(errors.length).toBe(0);

  // Read generated file
  const content = await readFile(TEST_MEMORY_MD, "utf-8");

  // Check structure
  expect(content).toContain("# Ambrogio Agent - Memory");
  expect(content).toContain("## User Preferences");
  expect(content).toContain("## Facts & Knowledge");
  expect(content).toContain("## Behavioral Patterns");

  // Check specific memories
  expect(content).toContain("usa sempre bun per i progetti TypeScript");
  expect(content).toContain("server IP: 192.168.1.10");
  expect(content).toContain("tende a dimenticare i commit prima del push");

  // Check metadata
  expect(content).toContain("**Confidence**: 100%"); // default for preferences/facts
  expect(content).toContain("**Confidence**: 85%"); // custom for pattern
  expect(content).toContain("**Source**: explicit");
  expect(content).toContain("**Tags**: `tooling`, `package-manager`");
  expect(content).toContain("**Tags**: `infrastructure`");
});

test("memory.sync - should handle empty memory gracefully", async () => {
  // Clear all memories
  const listResult = await runAmbrogioCtl(
    ["memory", "list", "--json"],
    {
      socketPath: TEST_SOCKET,
      stdout: () => {},
      stderr: () => {},
    }
  );

  // Delete all memories manually by clearing state
  stateStore.clearRuntimeValues(
    stateStore.getAllRuntimeKeys("memory:*").map((entry) => entry.key)
  );

  const outputs: string[] = [];
  const exitCode = await runAmbrogioCtl(
    ["memory", "sync", "--output", TEST_MEMORY_MD],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: () => {},
    }
  );

  expect(exitCode).toBe(0);

  const content = await readFile(TEST_MEMORY_MD, "utf-8");
  expect(content).toContain("## No Memories Yet");
  expect(content).toContain("Use `ambrogioctl memory add` to create memories");
});
