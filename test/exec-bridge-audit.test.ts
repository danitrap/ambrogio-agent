import { describe, expect, test } from "bun:test";
import { extractCodexAuditActions } from "../src/model/exec-bridge";

describe("extractCodexAuditActions", () => {
  test("extracts shell exec and web search actions from codex stderr", () => {
    const stderr = [
      "thinking",
      "🌐 Searched: https://news.ycombinator.com/",
      "exec",
      "/bin/sh -lc 'bash /data/.codex/skills/screenshot-only/scripts/screenshot-url.sh \"https://example.com\"' in /data succeeded in 2.54s:",
      "codex",
    ].join("\n");

    const actions = extractCodexAuditActions(stderr);
    expect(actions).toEqual([
      { type: "web_search", detail: "https://news.ycombinator.com/" },
      {
        type: "shell_exec",
        detail: "/bin/sh -lc 'bash /data/.codex/skills/screenshot-only/scripts/screenshot-url.sh \"https://example.com\"' [cwd=/data] [status=succeeded]",
      },
    ]);
  });

  test("deduplicates repeated actions", () => {
    const stderr = [
      "🌐 Searched: Hacker News first post front page",
      "🌐 Searched: Hacker News first post front page",
      "exec",
      "/bin/sh -lc 'ls -la' in /data succeeded in 50ms:",
      "exec",
      "/bin/sh -lc 'ls -la' in /data succeeded in 51ms:",
    ].join("\n");

    const actions = extractCodexAuditActions(stderr);
    expect(actions).toEqual([
      { type: "web_search", detail: "Hacker News first post front page" },
      { type: "shell_exec", detail: "/bin/sh -lc 'ls -la' [cwd=/data] [status=succeeded]" },
    ]);
  });
});
