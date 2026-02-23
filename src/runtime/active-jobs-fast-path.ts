import type { JobEntry } from "./state-store";

const ACTIVE_STATUS_ORDER: JobEntry["status"][] = [
  "running",
  "scheduled",
  "completed_pending_delivery",
  "failed_pending_delivery",
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function isActiveJobsListQuery(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const hasJobWord = /\b(job|jobs|task|tasks)\b/.test(normalized);
  if (!hasJobWord) {
    return false;
  }

  return /\b(attiv[oi]?|in corso|running|quali|elenca|lista|mostra|ci sono|schedulat[ioe]?|pianificat[ioe]?)\b/.test(
    normalized,
  );
}

function statusLabel(status: JobEntry["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "scheduled":
      return "scheduled";
    case "completed_pending_delivery":
      return "completed_pending_delivery";
    case "failed_pending_delivery":
      return "failed_pending_delivery";
    default:
      return status;
  }
}

function sortActiveJobs(a: JobEntry, b: JobEntry): number {
  const aStatus = ACTIVE_STATUS_ORDER.indexOf(a.status);
  const bStatus = ACTIVE_STATUS_ORDER.indexOf(b.status);
  if (aStatus !== bStatus) {
    return aStatus - bStatus;
  }

  const aRunAt = a.runAt ? Date.parse(a.runAt) : Number.MAX_SAFE_INTEGER;
  const bRunAt = b.runAt ? Date.parse(b.runAt) : Number.MAX_SAFE_INTEGER;
  if (aRunAt !== bRunAt) {
    return aRunAt - bRunAt;
  }

  return a.createdAt.localeCompare(b.createdAt);
}

function formatWhen(runAt: string | null): string {
  return runAt ? runAt : "n/a";
}

export function buildActiveJobsFastReply(jobs: JobEntry[]): string {
  if (jobs.length === 0) {
    return "Nessun job attivo in questo momento.";
  }

  const sorted = [...jobs].sort(sortActiveJobs);
  const lines = [
    `Job attivi: ${sorted.length}`,
    "",
  ];

  for (const [index, job] of sorted.entries()) {
    let muteInfo = "unmuted";
    if (job.mutedUntil) {
      const mutedUntilMs = Date.parse(job.mutedUntil);
      if (Number.isNaN(mutedUntilMs)) {
        muteInfo = `mutedUntil=${job.mutedUntil}`;
      } else if (mutedUntilMs > Date.now()) {
        muteInfo = `mutedUntil=${job.mutedUntil}`;
      } else {
        muteInfo = `muteExpiredAt=${job.mutedUntil}`;
      }
    }
    lines.push(
      `${index + 1}. ${job.taskId} | ${job.kind} | ${statusLabel(job.status)} | runAt=${formatWhen(job.runAt)} | ${muteInfo}`,
    );
  }

  return lines.join("\n");
}
