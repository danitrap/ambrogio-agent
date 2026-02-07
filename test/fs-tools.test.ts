import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { FsTools } from "../src/tools/fs-tools";

describe("FsTools", () => {
  test("reads and writes files under root", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
    const tools = new FsTools({ root: temp });
    await tools.init();

    const writeResult = await tools.writeFile("notes.txt", "hello");
    expect(writeResult.path).toBe("notes.txt");

    const readResult = await tools.readFile("notes.txt");
    expect(readResult.content).toBe("hello");
  });

  test("rejects path traversal", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
    const root = path.join(base, "root");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(base, "outside.txt"), "nope", "utf8");

    const tools = new FsTools({ root });
    await tools.init();

    await expect(tools.readFile("../outside.txt")).rejects.toThrow("Path escapes root");
  });

  test("rejects symlink escape", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
    const root = path.join(base, "root");
    await mkdir(root, { recursive: true });
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, path.join(root, "link.txt"));

    const tools = new FsTools({ root });
    await tools.init();

    await expect(tools.readFile("link.txt")).rejects.toThrow("Path escapes root");
  });

  test("searches matching lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
    await writeFile(path.join(root, "a.txt"), "milk\nbread\n", "utf8");

    const tools = new FsTools({ root });
    await tools.init();

    const results = await tools.search("milk");
    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe("a.txt");
    expect(results[0]?.line).toBe(1);
  });

  test("checks expected hash before overwrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-fs-"));
    await writeFile(path.join(root, "item.txt"), "v1", "utf8");

    const tools = new FsTools({ root });
    await tools.init();

    await expect(tools.writeFile("item.txt", "v2", "bad-hash")).rejects.toThrow("Hash mismatch");

    const finalContent = await readFile(path.join(root, "item.txt"), "utf8");
    expect(finalContent).toBe("v1");
  });
});
