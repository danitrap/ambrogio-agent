import { describe, expect, test } from "bun:test";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

type RecordedCall = { op: string; args: Record<string, unknown> };

describe("ambrogioctl", () => {
  test("tasks list emits json when requested", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const err: string[] = [];

    const code = await runAmbrogioCtl(["tasks", "list", "--limit", "5", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { tasks: [{ taskId: "dl-1", status: "scheduled" }] } };
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "tasks.list", args: { limit: 5 } }]);
    expect(JSON.parse(out[0] ?? "")).toEqual({ tasks: [{ taskId: "dl-1", status: "scheduled" }] });
    expect(err).toEqual([]);
  });

  test("tasks inspect requires id", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["tasks", "inspect"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: true, result: {} }),
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(2);
    expect(err[0]).toContain("--id");
  });

  test("maps rpc not found errors to exit code 3", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["tasks", "cancel", "--id", "missing"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Task non trovato" } }),
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(3);
    expect(err[0]).toContain("Task non trovato");
  });

  test("tasks create sends required payload", async () => {
    const calls: RecordedCall[] = [];
    const code = await runAmbrogioCtl(
      [
        "tasks",
        "create",
        "--run-at",
        "2099-01-01T10:00:00.000Z",
        "--prompt",
        "hello",
        "--user-id",
        "1",
        "--chat-id",
        "2",
      ],
      {
        socketPath: "/tmp/ambrogio.sock",
        sendRpc: async (op, args) => {
          calls.push({ op, args });
          return { ok: true, result: { taskId: "dl-rpc-1" } };
        },
        stdout: () => {},
        stderr: () => {},
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        op: "tasks.create",
        args: {
          runAtIso: "2099-01-01T10:00:00.000Z",
          prompt: "hello",
          userId: 1,
          chatId: 2,
        },
      },
    ]);
  });
});
