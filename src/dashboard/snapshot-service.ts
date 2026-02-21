import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StateStore } from "../runtime/state-store";
import { parseGroceriesMarkdown, parseTodoMarkdown } from "./parsers";
import type { DashboardSnapshot } from "./types";

export type DashboardSnapshotService = {
  getSnapshot: () => Promise<DashboardSnapshot>;
};

type CreateDashboardSnapshotServiceOptions = {
  stateStore: StateStore;
  dataRoot: string;
};

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export function createDashboardSnapshotService(
  options: CreateDashboardSnapshotServiceOptions,
): DashboardSnapshotService {
  return {
    getSnapshot: async () => {
      const now = Date.now();
      const jobs = options.stateStore
        .getActiveBackgroundJobs(1000)
        .filter((job) =>
          job.status === "scheduled" &&
          job.runAt !== null &&
          Date.parse(job.runAt) >= now &&
          (job.kind === "delayed" || (job.kind === "recurring" && job.recurrenceEnabled))
        )
        .sort((a, b) => {
          const aTs = Date.parse(a.runAt ?? "");
          const bTs = Date.parse(b.runAt ?? "");
          return aTs - bTs;
        })
        .map((job) => ({
          id: job.taskId,
          kind: job.kind as "delayed" | "recurring",
          status: job.status,
          runAt: job.runAt as string,
          recurrenceType: job.recurrenceType,
          recurrenceExpression: job.recurrenceExpression,
          mutedUntil: job.mutedUntil,
          requestPreview: job.requestPreview,
        }));

      const todoFile = await readTextOrEmpty(path.join(options.dataRoot, "TODO.md"));
      const groceriesFile = await readTextOrEmpty(path.join(options.dataRoot, "groceries.md"));
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      return {
        generatedAt: new Date().toISOString(),
        timezone,
        jobs,
        todo: parseTodoMarkdown(todoFile),
        groceries: parseGroceriesMarkdown(groceriesFile),
      };
    },
  };
}
