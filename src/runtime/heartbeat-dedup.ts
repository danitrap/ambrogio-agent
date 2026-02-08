export function shouldDeduplicateHeartbeatMessage(params: {
  lastFingerprint: string | null;
  lastSentAtIso: string | null;
  nextFingerprint: string;
  nowMs: number;
  dedupWindowMs: number;
}): boolean {
  if (params.lastFingerprint !== params.nextFingerprint) {
    return false;
  }
  if (!params.lastSentAtIso) {
    return false;
  }

  const lastMs = Date.parse(params.lastSentAtIso);
  if (!Number.isFinite(lastMs)) {
    return false;
  }

  return params.nowMs - lastMs < params.dedupWindowMs;
}
