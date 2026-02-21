import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
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

const HEARTBEAT_STALE_WARN_MINUTES = 90;
const HEARTBEAT_STALE_CRITICAL_MINUTES = 180;
const KNOWLEDGE_PREVIEW_MAX_LINES = 24;

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readFileMeta(filePath: string): Promise<{ exists: boolean; updatedAt: string | null }> {
  try {
    const data = await stat(filePath);
    return {
      exists: true,
      updatedAt: data.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      updatedAt: null,
    };
  }
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0s";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function toPreviewLines(content: string, maxLines = KNOWLEDGE_PREVIEW_MAX_LINES): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

export function createDashboardSnapshotService(
  options: CreateDashboardSnapshotServiceOptions,
): DashboardSnapshotService {
  return {
    getSnapshot: async () => {
      const now = Date.now();
      const activeJobs = options.stateStore.getActiveBackgroundJobs(1000);
      const jobs = activeJobs
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
      const pendingJobs = options.stateStore.getPendingBackgroundJobs(1000);
      const failedPendingDelivery = pendingJobs.filter((job) => job.status === "failed_pending_delivery").length;
      const pendingDelivery = pendingJobs.length;
      const running = activeJobs.filter((job) => job.status === "running").length;
      const scheduled = activeJobs.filter(
        (job) => job.status === "scheduled" && (job.kind === "delayed" || (job.kind === "recurring" && job.recurrenceEnabled)),
      ).length;
      const heartbeatLastRunAt = options.stateStore.getRuntimeValue("heartbeat_last_run_at");
      const heartbeatLastResult = options.stateStore.getRuntimeValue("heartbeat_last_result");
      const heartbeatLastRunAtMs = heartbeatLastRunAt ? Date.parse(heartbeatLastRunAt) : Number.NaN;
      const minutesSinceLastRun =
        Number.isFinite(heartbeatLastRunAtMs) && heartbeatLastRunAtMs > 0
          ? Math.max(0, Math.floor((now - heartbeatLastRunAtMs) / 60000))
          : null;
      const heartbeatError = heartbeatLastResult === "error";
      const heartbeatStatus = (() => {
        if (heartbeatError) {
          return "critical" as const;
        }
        if (minutesSinceLastRun !== null && minutesSinceLastRun >= HEARTBEAT_STALE_CRITICAL_MINUTES) {
          return "critical" as const;
        }
        if (
          minutesSinceLastRun === null ||
          minutesSinceLastRun >= HEARTBEAT_STALE_WARN_MINUTES ||
          heartbeatLastResult === "never" ||
          heartbeatLastResult === "skipped_inflight" ||
          heartbeatLastResult === "skipped_quiet_hours"
        ) {
          return "warn" as const;
        }
        return "ok" as const;
      })();
      const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));

      const todoFile = await readTextOrEmpty(path.join(options.dataRoot, "TODO.md"));
      const groceriesFile = await readTextOrEmpty(path.join(options.dataRoot, "groceries.md"));
      const memoryFile = await readTextOrEmpty(path.join(options.dataRoot, "MEMORY.md"));
      const notesFile = await readTextOrEmpty(path.join(options.dataRoot, "NOTES.md"));
      const memoryFileMeta = await readFileMeta(path.join(options.dataRoot, "MEMORY.md"));
      const notesFileMeta = await readFileMeta(path.join(options.dataRoot, "NOTES.md"));
      const memoryEntries = options.stateStore.getAllRuntimeKeys("memory:*").length;
      const notesEntries = options.stateStore.getAllRuntimeKeys("notes:entry:*").length;
      const fetchUrlCacheEntries = options.stateStore.getAllRuntimeKeys("fetch-url:cache:*").length;
      const ttsAudioCacheEntries = options.stateStore.getAllRuntimeKeys("tts:audio:*").length;
      const atmTramScheduleCacheEntries = options.stateStore.getAllRuntimeKeys("atm-tram-schedule:cache:*").length;
      const atmTramScheduleGtfsTimestampPresent =
        options.stateStore.getRuntimeValue("atm-tram-schedule:gtfs:timestamp") !== null;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      return {
        generatedAt: new Date().toISOString(),
        timezone,
        jobs,
        health: {
          heartbeat: {
            status: heartbeatStatus,
            lastRunAt: heartbeatLastRunAt,
            lastResult: heartbeatLastResult,
            minutesSinceLastRun,
            staleAfterMinutes: HEARTBEAT_STALE_WARN_MINUTES,
          },
          errors: {
            failedPendingDelivery,
            heartbeatError,
            total: failedPendingDelivery + (heartbeatError ? 1 : 0),
          },
          pending: {
            scheduled,
            running,
            pendingDelivery,
            total: scheduled + running + pendingDelivery,
          },
          uptime: {
            seconds: uptimeSeconds,
            human: formatDuration(uptimeSeconds),
          },
        },
        todo: parseTodoMarkdown(todoFile),
        groceries: parseGroceriesMarkdown(groceriesFile),
        knowledge: {
          memory: {
            ...memoryFileMeta,
            previewLines: toPreviewLines(memoryFile),
          },
          notes: {
            ...notesFileMeta,
            previewLines: toPreviewLines(notesFile),
          },
          stateCounts: {
            memoryEntries,
            notesEntries,
          },
        },
        skillState: {
          fetchUrlCacheEntries,
          ttsAudioCacheEntries,
          atmTramScheduleCacheEntries,
          atmTramScheduleGtfsTimestampPresent,
        },
      };
    },
  };
}
