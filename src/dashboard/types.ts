export type BoardItem = {
  id: string;
  text: string;
};

export type BoardColumn = {
  id: string;
  title: string;
  items: BoardItem[];
};

export type DashboardJob = {
  id: string;
  kind: "delayed" | "recurring";
  status: string;
  runAt: string;
  recurrenceType: "interval" | "cron" | null;
  recurrenceExpression: string | null;
  mutedUntil: string | null;
  requestPreview: string;
};

export type DashboardSnapshot = {
  generatedAt: string;
  timezone: string;
  jobs: DashboardJob[];
  health: {
    heartbeat: {
      status: "ok" | "warn" | "critical";
      lastRunAt: string | null;
      lastResult: string | null;
      minutesSinceLastRun: number | null;
      staleAfterMinutes: number;
    };
    errors: {
      failedPendingDelivery: number;
      heartbeatError: boolean;
      total: number;
    };
    pending: {
      scheduled: number;
      running: number;
      pendingDelivery: number;
      total: number;
    };
    uptime: {
      seconds: number;
      human: string;
    };
  };
  todo: {
    columns: BoardColumn[];
  };
  groceries: {
    columns: BoardColumn[];
  };
};
