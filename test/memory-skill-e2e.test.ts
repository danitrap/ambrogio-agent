import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { $ } from "bun";
import path from "node:path";
import { StateStore } from "../src/runtime/state-store";
import { startJobRpcServer } from "../src/runtime/job-rpc-server";

const TEST_ROOT = path.join(import.meta.dir, "test-data-skill-e2e");
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

  // Set socket path in environment
  process.env.AMBROGIO_SOCKET_PATH = TEST_SOCKET;

  // Add project bin to PATH for ambrogioctl
  const binDir = path.join(import.meta.dir, "..", "bin");
  process.env.PATH = `${binDir}:${process.env.PATH}`;
});

afterAll(async () => {
  await rpcHandle.close();
  stateStore.close();
  await rm(TEST_ROOT, { recursive: true, force: true });
  delete process.env.AMBROGIO_SOCKET_PATH;
});

test("memory-manager skill - add.sh should create memory", async () => {
  const result = await $`bash ${path.join(import.meta.dir, "..", "skills", "memory-manager", "scripts", "add.sh")} --type preference --content "usa sempre bun" --tags "tooling"`.text();

  expect(result).toContain("Memory added: preference:");
});

test("memory-manager skill - list.sh should show memories", async () => {
  const result = await $`bash ${path.join(import.meta.dir, "..", "skills", "memory-manager", "scripts", "list.sh")}`.text();

  expect(result).toContain("usa sempre bun");
});

test("memory-manager skill - search.sh should find memories", async () => {
  const result = await $`bash ${path.join(import.meta.dir, "..", "skills", "memory-manager", "scripts", "search.sh")} --query "bun"`.text();

  expect(result).toContain("usa sempre bun");
});

test("memory-manager skill - sync.sh should generate MEMORY.md", async () => {
  await $`bash ${path.join(import.meta.dir, "..", "skills", "memory-manager", "scripts", "sync.sh")} --output ${TEST_MEMORY_MD}`.text();

  const content = await readFile(TEST_MEMORY_MD, "utf-8");
  expect(content).toContain("# Ambrogio Agent - Memory");
  expect(content).toContain("usa sempre bun");
});
