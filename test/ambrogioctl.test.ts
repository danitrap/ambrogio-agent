import { describe, expect, test } from "bun:test";
import { runAmbrogioCtl } from "../src/cli/ambrogioctl";

type RecordedCall = { op: string; args: Record<string, unknown> };

describe("ambrogioctl", () => {
  test("jobs list emits json when requested", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const err: string[] = [];

    const code = await runAmbrogioCtl(["jobs", "list", "--limit", "5", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { tasks: [{ taskId: "dl-1", status: "scheduled" }] } };
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "jobs.list", args: { limit: 5 } }]);
    expect(JSON.parse(out[0] ?? "")).toEqual({ tasks: [{ taskId: "dl-1", status: "scheduled" }] });
    expect(err).toEqual([]); // No deprecation warning when using jobs scope
  });

  test("jobs inspect requires id", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["jobs", "inspect"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: true, result: {} }),
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(2);
    expect(err.some(line => line.includes("--id"))).toBe(true);
  });

  test("jobs list human-readable output includes mute status", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await runAmbrogioCtl(["jobs", "list", "--limit", "5"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({
        ok: true,
        result: {
          tasks: [
            {
              taskId: "dl-1",
              kind: "delayed",
              status: "scheduled",
              runAt: "2099-01-01T10:00:00.000Z",
              mutedUntil: "2099-01-02T10:00:00.000Z",
            },
            {
              taskId: "dl-2",
              kind: "delayed",
              status: "scheduled",
              runAt: "2099-01-01T12:00:00.000Z",
              mutedUntil: null,
            },
          ],
        },
      }),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(0);
    expect(out[0]).toContain("dl-1 | delayed | scheduled | runAt=2099-01-01T10:00:00.000Z | mutedUntil=2099-01-02T10:00:00.000Z");
    expect(out[0]).toContain("dl-2 | delayed | scheduled | runAt=2099-01-01T12:00:00.000Z | unmuted");
    expect(err).toEqual([]);
  });

  test("maps rpc not found errors to exit code 3", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["jobs", "cancel", "--id", "missing"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Job non trovato" } }),
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(3);
    expect(err.some(line => line.includes("Job non trovato"))).toBe(true);
  });

  test("status emits json when requested", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const statusData = { now: "2026-02-08T10:00:00.000Z", uptime: "1h", handledMessages: 5 };

    const code = await runAmbrogioCtl(["status", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: statusData };
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "status.get", args: {} }]);
    expect(JSON.parse(out[0] ?? "")).toEqual(statusData);
    expect(err).toEqual([]);
  });

  test("status emits human-readable by default", async () => {
    const out: string[] = [];

    const code = await runAmbrogioCtl(["status"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: true, result: { uptime: "2h", handledMessages: 10 } }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out[0]).toContain("uptime: 2h");
    expect(out[0]).toContain("handledMessages: 10");
  });

  test("mac ping prints concise output", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const code = await runAmbrogioCtl(["mac", "ping"], {
      socketPath: "/tmp/ambrogio.sock",
      sendMacRpc: async (method, payload) => {
        calls.push({ method, payload });
        return {
          jsonrpc: "2.0",
          id: "1",
          result: { ok: true, service: "mac-tools-service", version: "1.0.0" },
        };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ method: "system.ping", payload: undefined }]);
    expect(out[0]).toBe("mac-tools-service 1.0.0");
  });

  test("mac calendar upcoming validates arguments", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["mac", "calendar", "upcoming", "--days", "0"], {
      socketPath: "/tmp/ambrogio.sock",
      stdout: () => {},
      stderr: (line) => err.push(line),
    });
    expect(code).toBe(2);
    expect(err[0]).toContain("--days must be a positive integer.");
  });

  test("mac reminders open validates include-no-due-date", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(["mac", "reminders", "open", "--include-no-due-date", "maybe"], {
      socketPath: "/tmp/ambrogio.sock",
      stdout: () => {},
      stderr: (line) => err.push(line),
    });
    expect(code).toBe(2);
    expect(err[0]).toContain("must be true or false");
  });

  test("mac reminders open emits json when requested", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const code = await runAmbrogioCtl(["mac", "reminders", "open", "--limit", "5", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendMacRpc: async (method, payload) => {
        calls.push({ method, payload });
        return {
          jsonrpc: "2.0",
          id: "1",
          result: {
            generatedAt: "2026-02-23T10:00:00.000Z",
            items: [{ id: "r1", title: "x", dueAt: null, listName: "Inbox", isFlagged: false, tags: ["@next"] }],
            count: 1,
          },
        };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ method: "reminders.open", payload: { limit: 5 } }]);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ count: 1 });
  });

  test("mac reminders open renders relative due status in text mode", async () => {
    const out: string[] = [];
    const code = await runAmbrogioCtl(["mac", "reminders", "open", "--limit", "5"], {
      socketPath: "/tmp/ambrogio.sock",
      sendMacRpc: async () => ({
        jsonrpc: "2.0",
        id: "1",
        result: {
          generatedAt: "2026-02-23T10:00:00.000Z",
          generatedAtEpochMs: Date.parse("2026-02-23T10:00:00.000Z"),
          timezone: "Europe/Rome",
          items: [
            {
              id: "r1",
              title: "Soon",
              dueAt: "2026-02-23T11:00:00.000Z",
              dueInMinutes: 60,
              dueAtEpochMs: Date.parse("2026-02-23T11:00:00.000Z"),
              isOverdue: false,
              listName: "Inbox",
              isFlagged: false,
              tags: [],
            },
            {
              id: "r2",
              title: "Late",
              dueAt: "2026-02-23T09:50:00.000Z",
              dueInMinutes: -10,
              dueAtEpochMs: Date.parse("2026-02-23T09:50:00.000Z"),
              isOverdue: true,
              listName: "Inbox",
              isFlagged: true,
              tags: ["@next"],
            },
          ],
          count: 2,
        },
      }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("in 60m");
    expect(out.join("\n")).toContain("overdue 10m");
  });

  test("mac calendar upcoming renders relative start status in text mode", async () => {
    const out: string[] = [];
    const code = await runAmbrogioCtl(["mac", "calendar", "upcoming", "--days", "1"], {
      socketPath: "/tmp/ambrogio.sock",
      sendMacRpc: async () => ({
        jsonrpc: "2.0",
        id: "1",
        result: {
          generatedAtEpochMs: Date.parse("2026-02-23T10:00:00.000Z"),
          window: {
            from: "2026-02-23T10:00:00.000Z",
            to: "2026-02-24T10:00:00.000Z",
            timezone: "Europe/Rome",
          },
          events: [
            {
              id: "e1",
              title: "Future",
              startAt: "2026-02-23T10:30:00.000Z",
              endAt: "2026-02-23T11:30:00.000Z",
              startAtEpochMs: Date.parse("2026-02-23T10:30:00.000Z"),
              endAtEpochMs: Date.parse("2026-02-23T11:30:00.000Z"),
              startInMinutes: 30,
              endInMinutes: 90,
              isStarted: false,
              isEnded: false,
              isOngoing: false,
              calendarName: "Work",
              allDay: false,
            },
            {
              id: "e2",
              title: "Live",
              startAt: "2026-02-23T09:45:00.000Z",
              endAt: "2026-02-23T10:15:00.000Z",
              startAtEpochMs: Date.parse("2026-02-23T09:45:00.000Z"),
              endAtEpochMs: Date.parse("2026-02-23T10:15:00.000Z"),
              startInMinutes: -15,
              endInMinutes: 15,
              isStarted: true,
              isEnded: false,
              isOngoing: true,
              calendarName: "Work",
              allDay: false,
            },
          ],
          count: 2,
        },
      }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("starts in 30m");
    expect(out.join("\n")).toContain("ongoing");
  });

  test("jobs create resolves user/chat from TELEGRAM_ALLOWED_USER_ID", async () => {
    const calls: RecordedCall[] = [];
    const code = await runAmbrogioCtl(
      [
        "jobs",
        "create",
        "--run-at",
        "2099-01-01T10:00:00.000Z",
        "--prompt",
        "hello",
      ],
      {
        socketPath: "/tmp/ambrogio.sock",
        env: { TELEGRAM_ALLOWED_USER_ID: "777" },
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
        op: "jobs.create",
        args: {
          runAtIso: "2099-01-01T10:00:00.000Z",
          prompt: "hello",
          userId: 777,
          chatId: 777,
        },
      },
    ]);
  });

  test("jobs create-recurring resolves user/chat from TELEGRAM_ALLOWED_USER_ID", async () => {
    const calls: RecordedCall[] = [];
    const code = await runAmbrogioCtl(
      [
        "jobs",
        "create-recurring",
        "--run-at",
        "2099-01-01T10:00:00.000Z",
        "--prompt",
        "daily check",
        "--type",
        "cron",
        "--expression",
        "0 9 * * *",
      ],
      {
        socketPath: "/tmp/ambrogio.sock",
        env: { TELEGRAM_ALLOWED_USER_ID: "888" },
        sendRpc: async (op, args) => {
          calls.push({ op, args });
          return { ok: true, result: { taskId: "rc-rpc-1" } };
        },
        stdout: () => {},
        stderr: () => {},
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        op: "jobs.create-recurring",
        args: {
          runAtIso: "2099-01-01T10:00:00.000Z",
          prompt: "daily check",
          userId: 888,
          chatId: 888,
          recurrenceType: "cron",
          recurrenceExpression: "0 9 * * *",
        },
      },
    ]);
  });

  test("jobs create fails when TELEGRAM_ALLOWED_USER_ID is missing", async () => {
    const err: string[] = [];
    const code = await runAmbrogioCtl(
      [
        "jobs",
        "create",
        "--run-at",
        "2099-01-01T10:00:00.000Z",
        "--prompt",
        "hello",
      ],
      {
        socketPath: "/tmp/ambrogio.sock",
        env: {},
        sendRpc: async () => ({ ok: true, result: {} }),
        stdout: () => {},
        stderr: (line) => err.push(line),
      },
    );

    expect(code).toBe(2);
    expect(err.some((line) => line.includes("TELEGRAM_ALLOWED_USER_ID"))).toBe(true);
  });

  test("telegram send-photo forwards path and prints human output", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const code = await runAmbrogioCtl(["telegram", "send-photo", "--path", "/data/pic.png"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return {
          ok: true,
          result: { method: "sendPhoto", path: "/data/pic.png", telegramMessageId: 42, sizeBytes: 1024 },
        };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "telegram.sendPhoto", args: { path: "/data/pic.png" } }]);
    expect(out[0]).toContain("method: sendPhoto");
    expect(out[0]).toContain("telegramMessageId: 42");
  });

  test("telegram send-message supports positional text", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const code = await runAmbrogioCtl(["telegram", "send-message", "ciao", "mondo"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { ok: true } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "telegram.sendMessage", args: { text: "ciao mondo" } }]);
    expect(out[0]).toContain("Message sent successfully.");
  });

  test("telegram send-document supports json output", async () => {
    const out: string[] = [];
    const code = await runAmbrogioCtl(["telegram", "send-document", "--path", "/data/a.pdf", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({
        ok: true,
        result: { method: "sendDocument", path: "/data/a.pdf", telegramMessageId: 77, sizeBytes: 55 },
      }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      method: "sendDocument",
      path: "/data/a.pdf",
      telegramMessageId: 77,
      sizeBytes: 55,
    });
  });

  test("state get with flag", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "get", "--key", "test:key"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { key: "test:key", value: "test value" } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.get", args: { key: "test:key" } }]);
    expect(out[0]).toBe("test:key=test value");
  });

  test("state get with positional arg", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "get", "mykey"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { key: "mykey", value: "myvalue" } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.get", args: { key: "mykey" } }]);
    expect(out[0]).toBe("mykey=myvalue");
  });

  test("state get json format", async () => {
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "get", "test:key", "--json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: true, result: { key: "test:key", value: "test value" } }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual({ key: "test:key", value: "test value" });
  });

  test("state get not found returns exit code 3", async () => {
    const err: string[] = [];

    const code = await runAmbrogioCtl(["state", "get", "missing"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Key not found: missing" } }),
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(3);
    expect(err[0]).toContain("Key not found");
  });

  test("state set with flags", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "set", "--key", "test:key", "--value", "new value"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { key: "test:key", value: "new value" } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.set", args: { key: "test:key", value: "new value" } }]);
    expect(out[0]).toBe("Set test:key=new value");
  });

  test("state set with positional args", async () => {
    const calls: RecordedCall[] = [];

    const code = await runAmbrogioCtl(["state", "set", "mykey", "myvalue"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { key: "mykey", value: "myvalue" } };
      },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.set", args: { key: "mykey", value: "myvalue" } }]);
  });

  test("state delete multiple keys", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "delete", "key1", "key2", "key3"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { deleted: 3 } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.delete", args: { keys: ["key1", "key2", "key3"] } }]);
    expect(out[0]).toBe("Deleted 3 key(s)");
  });

  test("state list without pattern", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["state", "list"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return {
          ok: true,
          result: {
            entries: [
              { key: "key1", value: "value1", updatedAt: "2026-02-09T10:00:00Z" },
              { key: "key2", value: "value2", updatedAt: "2026-02-09T10:00:00Z" },
            ],
          },
        };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.list", args: { pattern: undefined } }]);
    expect(out[0]).toBe("key1=value1\nkey2=value2");
  });

  test("state list with pattern", async () => {
    const calls: RecordedCall[] = [];

    const code = await runAmbrogioCtl(["state", "list", "--pattern", "test:*"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { entries: [] } };
      },
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "state.list", args: { pattern: "test:*" } }]);
  });

  test("conversation stats with user-id", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["conversation", "stats", "--user-id", "123"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { entries: 10, userTurns: 5, assistantTurns: 5, hasContext: true, userId: 123 } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "conversation.stats", args: { userId: 123 } }]);
    expect(out[0]).toContain("entries: 10");
    expect(out[0]).toContain("userTurns: 5");
  });

  test("conversation list with limit", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["conversation", "list", "--user-id", "123", "--limit", "5"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return {
          ok: true,
          result: {
            entries: [
              { role: "user", text: "Hello" },
              { role: "assistant", text: "Hi there" },
            ],
            userId: 123,
            count: 2,
          },
        };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "conversation.list", args: { userId: 123, limit: 5 } }]);
    expect(out[0]).toContain("1. [user] Hello");
    expect(out[0]).toContain("2. [assistant] Hi there");
  });

  test("conversation clear with user-id", async () => {
    const calls: RecordedCall[] = [];
    const out: string[] = [];

    const code = await runAmbrogioCtl(["conversation", "clear", "--user-id", "123"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async (op, args) => {
        calls.push({ op, args });
        return { ok: true, result: { deleted: 10, userId: 123 } };
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ op: "conversation.clear", args: { userId: 123 } }]);
    expect(out[0]).toBe("Cleared 10 conversation entries for user 123");
  });

  test("conversation export with text format", async () => {
    const out: string[] = [];

    const code = await runAmbrogioCtl(["conversation", "export", "--user-id", "123", "--format", "text"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({
        ok: true,
        result: {
          entries: [
            { role: "user", text: "Hello", createdAt: "2026-02-09T10:00:00Z" },
            { role: "assistant", text: "Hi", createdAt: "2026-02-09T10:00:01Z" },
          ],
          stats: { entries: 2, userTurns: 1, assistantTurns: 1, hasContext: true },
          userId: 123,
        },
      }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out[0]).toContain("=== Conversation Export for User 123 ===");
    expect(out[0]).toContain("[2026-02-09T10:00:00Z] USER:");
    expect(out[0]).toContain("Hello");
  });

  test("conversation export with json format", async () => {
    const out: string[] = [];

    const code = await runAmbrogioCtl(["conversation", "export", "--user-id", "123", "--format", "json"], {
      socketPath: "/tmp/ambrogio.sock",
      sendRpc: async () => ({
        ok: true,
        result: {
          entries: [{ role: "user", text: "Hello", createdAt: "2026-02-09T10:00:00Z" }],
          stats: { entries: 1, userTurns: 1, assistantTurns: 0, hasContext: true },
          userId: 123,
        },
      }),
      stdout: (line) => out.push(line),
      stderr: () => {},
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.userId).toBe(123);
  });
});
