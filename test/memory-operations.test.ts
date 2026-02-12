import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { StateStore } from "../src/runtime/state-store";
import { startJobRpcServer } from "../src/runtime/job-rpc-server";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

const TEST_ROOT = path.join(import.meta.dir, "test-data-memory");
const TEST_SOCKET = path.join(TEST_ROOT, "test.sock");

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
});

afterAll(async () => {
  await rpcHandle.close();
  stateStore.close();
  await rm(TEST_ROOT, { recursive: true, force: true });
});

test("memory.add - should add a preference memory", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "add", "--type", "preference", "--content", "usa sempre bun"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs[0]).toContain("Memory added: preference:");
  expect(errors.length).toBe(0);
});

test("memory.add - should add a fact memory", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "add", "--type", "fact", "--content", "wifi password è guest123"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs[0]).toContain("Memory added: fact:");
});

test("memory.add - should add a pattern memory", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "add", "--type", "pattern", "--content", "tende a dimenticare i commit"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs[0]).toContain("Memory added: pattern:");
});

test("memory.list - should list all memories", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "list"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs.length).toBeGreaterThan(0);
  expect(outputs.join("\n")).toContain("usa sempre bun");
  expect(outputs.join("\n")).toContain("wifi password");
  expect(outputs.join("\n")).toContain("dimenticare i commit");
});

test("memory.list - should filter by type", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "list", "--type", "preference"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("usa sempre bun");
  expect(outputs.join("\n")).not.toContain("wifi password");
});

test("memory.search - should search by content", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "search", "--query", "bun"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("usa sempre bun");
  expect(outputs.join("\n")).not.toContain("wifi password");
});

test("memory.search - should return no matches for non-existent query", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "search", "--query", "nonexistent-query-xyz"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(0);
  expect(outputs.join("\n")).toContain("No matches found");
});

test("memory.add - should fail with invalid type", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "add", "--type", "invalid-type", "--content", "test content"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(2);
  expect(errors.join("\n")).toContain("--type must be 'preference', 'fact', or 'pattern'");
});

test("memory.add - should fail without required fields", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];

  const exitCode = await runAmbrogioCtl(
    ["memory", "add", "--type", "preference"],
    {
      socketPath: TEST_SOCKET,
      stdout: (line) => outputs.push(line),
      stderr: (line) => errors.push(line),
    }
  );

  expect(exitCode).toBe(2);
  expect(errors.join("\n")).toContain("--type and --content are required");
});
