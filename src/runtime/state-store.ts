import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

export type ConversationEntry = { role: "user" | "assistant"; text: string };
export type ConversationStats = { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean };
export type RecentMessageEntry = { createdAt: string; role: "user" | "assistant"; summary: string };
export type JobStatus =
  | "scheduled"
  | "running"
  | "completed_pending_delivery"
  | "completed_delivered"
  | "failed_pending_delivery"
  | "failed_delivered"
  | "canceled";
export type JobKind = "background" | "delayed" | "recurring";
export type RecurrenceType = "interval" | "cron" | null;
export type JobEntry = {
  taskId: string;
  kind: JobKind;
  updateId: number;
  userId: number;
  chatId: number;
  command: string | null;
  payloadPrompt: string | null;
  runAt: string | null;
  requestPreview: string;
  status: JobStatus;
  createdAt: string;
  timedOutAt: string;
  completedAt: string | null;
  deliveredAt: string | null;
  deliveryText: string | null;
  errorMessage: string | null;
  recurrenceType: RecurrenceType;
  recurrenceExpression: string | null;
  recurrenceMaxRuns: number | null;
  recurrenceRunCount: number;
  recurrenceEnabled: boolean;
};

// Type aliases for backwards compatibility
export type BackgroundTaskStatus = JobStatus;
export type TaskKind = JobKind;
export type BackgroundTaskEntry = JobEntry;

type RuntimeRow = { value: string };
type ConversationRow = { role: "user" | "assistant"; text: string };
type RecentRow = { created_at: string; role: "user" | "assistant"; summary: string };
type JobRow = {
  task_id: string;
  kind: JobKind;
  update_id: number;
  user_id: number;
  chat_id: number;
  command: string | null;
  payload_prompt: string | null;
  run_at: string | null;
  request_preview: string;
  status: JobStatus;
  created_at: string;
  timed_out_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  delivery_text: string | null;
  error_message: string | null;
  recurrence_type: string | null;
  recurrence_expression: string | null;
  recurrence_max_runs: number | null;
  recurrence_run_count: number;
  recurrence_enabled: number;
};

type BackgroundTaskRow = JobRow; // Backwards compatibility

export class StateStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.db.run("PRAGMA journal_mode=WAL;");
    this.db.run("PRAGMA busy_timeout=3000;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runtime_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS recent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL,
        summary TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_conversation_user_id ON conversation_messages(user_id, id);");
    this.ensureJobsTable();
  }

  private mapJobRow(row: JobRow): JobEntry {
    return {
      taskId: row.task_id,
      kind: row.kind,
      updateId: row.update_id,
      userId: row.user_id,
      chatId: row.chat_id,
      command: row.command,
      payloadPrompt: row.payload_prompt,
      runAt: row.run_at,
      requestPreview: row.request_preview,
      status: row.status,
      createdAt: row.created_at,
      timedOutAt: row.timed_out_at,
      completedAt: row.completed_at,
      deliveredAt: row.delivered_at,
      deliveryText: row.delivery_text,
      errorMessage: row.error_message,
      recurrenceType: row.recurrence_type as RecurrenceType,
      recurrenceExpression: row.recurrence_expression,
      recurrenceMaxRuns: row.recurrence_max_runs,
      recurrenceRunCount: row.recurrence_run_count,
      recurrenceEnabled: row.recurrence_enabled === 1,
    };
  }

  private ensureJobsTable(): void {
    // Check if jobs table already exists
    const jobsTableExists = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get();

    // Check if old table exists
    const oldTableExists = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='background_tasks'")
      .get();

    if (oldTableExists && !jobsTableExists) {
      // Migrate: background_tasks → jobs
      this.db.run(`
        CREATE TABLE jobs (
          task_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'background',
          update_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          chat_id INTEGER NOT NULL,
          command TEXT,
          payload_prompt TEXT,
          run_at TEXT,
          request_preview TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          timed_out_at TEXT NOT NULL,
          completed_at TEXT,
          delivered_at TEXT,
          delivery_text TEXT,
          error_message TEXT,
          recurrence_type TEXT,
          recurrence_expression TEXT,
          recurrence_max_runs INTEGER,
          recurrence_run_count INTEGER DEFAULT 0,
          recurrence_enabled INTEGER DEFAULT 1
        );
      `);

      // Copy existing data
      this.db.run(`
        INSERT INTO jobs SELECT
          task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at,
          request_preview, status, created_at, updated_at, timed_out_at, completed_at,
          delivered_at, delivery_text, error_message,
          NULL, NULL, NULL, 0, 1
        FROM background_tasks
      `);

      // Drop old table
      this.db.run("DROP TABLE background_tasks");
    } else if (!jobsTableExists) {
      // Create fresh jobs table
      this.db.run(`
        CREATE TABLE jobs (
          task_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'background',
          update_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          chat_id INTEGER NOT NULL,
          command TEXT,
          payload_prompt TEXT,
          run_at TEXT,
          request_preview TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          timed_out_at TEXT NOT NULL,
          completed_at TEXT,
          delivered_at TEXT,
          delivery_text TEXT,
          error_message TEXT,
          recurrence_type TEXT,
          recurrence_expression TEXT,
          recurrence_max_runs INTEGER,
          recurrence_run_count INTEGER DEFAULT 0,
          recurrence_enabled INTEGER DEFAULT 1
        );
      `);
    }

    // Create indexes
    this.db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_runAt ON jobs(status, run_at);");
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_jobs_recurring
        ON jobs(recurrence_type, recurrence_enabled, run_at)
        WHERE recurrence_type IS NOT NULL
    `);
  }

  static async open(dataRoot: string): Promise<StateStore> {
    const runtimeDir = path.join(dataRoot, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const dbPath = path.join(runtimeDir, "state.db");
    return new StateStore(new Database(dbPath));
  }

  close(): void {
    this.db.close();
  }

  getRuntimeValue(key: string): string | null {
    const row = this.db.query("SELECT value FROM runtime_kv WHERE key = ?1").get(key) as RuntimeRow | null;
    return row?.value ?? null;
  }

  setRuntimeValue(key: string, value: string): void {
    this.db.run(
      `INSERT INTO runtime_kv (key, value, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  clearRuntimeValues(keys: string[]): void {
    if (keys.length === 0) {
      return;
    }
    const placeholders = keys.map((_key, index) => `?${index + 1}`).join(", ");
    this.db.run(`DELETE FROM runtime_kv WHERE key IN (${placeholders})`, keys);
  }

  getAllRuntimeKeys(pattern?: string): Array<{ key: string; value: string; updatedAt: string }> {
    let query = "SELECT key, value, updated_at FROM runtime_kv";
    const params: string[] = [];

    if (pattern) {
      // Convert glob pattern (* and ?) to SQL LIKE pattern (% and _)
      const sqlPattern = pattern.replace(/\*/g, "%").replace(/\?/g, "_");
      query += " WHERE key LIKE ?1";
      params.push(sqlPattern);
    }

    query += " ORDER BY key ASC";

    const rows = this.db.query(query).all(...params) as Array<{ key: string; value: string; updated_at: string }>;
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  getRecentMessages(limit: number): RecentMessageEntry[] {
    const rows = this.db
      .query(
        `SELECT created_at, role, summary
         FROM recent_messages
         ORDER BY id DESC
         LIMIT ?1`,
      )
      .all(limit) as RecentRow[];

    return rows
      .slice()
      .reverse()
      .map((row) => ({
        createdAt: row.created_at,
        role: row.role,
        summary: row.summary,
      }));
  }

  appendRecentMessage(role: "user" | "assistant", summary: string, createdAt: string, maxEntries: number): void {
    this.db.run(
      `INSERT INTO recent_messages (created_at, role, summary)
       VALUES (?1, ?2, ?3)`,
      [createdAt, role, summary],
    );
    this.db.run(
      `DELETE FROM recent_messages
       WHERE id NOT IN (
         SELECT id FROM recent_messages ORDER BY id DESC LIMIT ?1
       )`,
      [maxEntries],
    );
  }

  clearRecentMessages(): void {
    this.db.run("DELETE FROM recent_messages");
  }

  getConversation(userId: number, limit = 12): ConversationEntry[] {
    const rows = this.db
      .query(
        `SELECT role, text
         FROM conversation_messages
         WHERE user_id = ?1
         ORDER BY id DESC
         LIMIT ?2`,
      )
      .all(userId, limit) as ConversationRow[];
    return rows.slice().reverse().map((row) => ({ role: row.role, text: row.text }));
  }

  getConversationWithTimestamps(
    userId: number,
    limit = 12,
  ): Array<{ role: "user" | "assistant"; text: string; createdAt: string }> {
    const rows = this.db
      .query(
        `SELECT role, text, created_at
         FROM conversation_messages
         WHERE user_id = ?1
         ORDER BY id DESC
         LIMIT ?2`,
      )
      .all(userId, limit) as Array<{ role: "user" | "assistant"; text: string; created_at: string }>;
    return rows.slice().reverse().map((row) => ({
      role: row.role,
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  appendConversationTurn(userId: number, role: "user" | "assistant", text: string, maxEntries = 12): void {
    this.db.run(
      `INSERT INTO conversation_messages (user_id, role, text, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
      [userId, role, text, new Date().toISOString()],
    );
    this.db.run(
      `DELETE FROM conversation_messages
       WHERE user_id = ?1
         AND id NOT IN (
           SELECT id FROM conversation_messages WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2
         )`,
      [userId, maxEntries],
    );
  }

  clearConversation(userId: number): void {
    this.db.run("DELETE FROM conversation_messages WHERE user_id = ?1", [userId]);
  }

  getConversationStats(userId: number): ConversationStats {
    const row = this.db
      .query(
        `SELECT
           COUNT(*) AS entries,
           SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns
         FROM conversation_messages
         WHERE user_id = ?1`,
      )
      .get(userId) as { entries: number; user_turns: number | null } | null;

    const entries = row?.entries ?? 0;
    const userTurns = row?.user_turns ?? 0;
    return {
      entries,
      userTurns,
      assistantTurns: entries - userTurns,
      hasContext: entries > 0,
    };
  }

  createBackgroundTask(params: {
    taskId: string;
    updateId: number;
    userId: number;
    chatId: number;
    command?: string;
    requestPreview: string;
  }): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO jobs (
        task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
        created_at, updated_at, timed_out_at
      ) VALUES (?1, 'background', ?2, ?3, ?4, ?5, ?6, NULL, ?7, 'running', ?8, ?8, ?8)`,
      [
        params.taskId,
        params.updateId,
        params.userId,
        params.chatId,
        params.command ?? null,
        null,
        params.requestPreview,
        now,
      ],
    );
  }

  createScheduledTask(params: {
    taskId: string;
    updateId: number;
    userId: number;
    chatId: number;
    command?: string;
    prompt: string;
    requestPreview: string;
    runAt: string;
  }): void {
    const now = new Date().toISOString();
    const runAtIso = new Date(params.runAt).toISOString();
    this.db.run(
      `INSERT INTO jobs (
        task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
        created_at, updated_at, timed_out_at
      ) VALUES (?1, 'delayed', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'scheduled', ?9, ?9, ?9)`,
      [
        params.taskId,
        params.updateId,
        params.userId,
        params.chatId,
        params.command ?? null,
        params.prompt,
        runAtIso,
        params.requestPreview,
        now,
      ],
    );
  }

  claimScheduledTask(taskId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE jobs
       SET status = 'running', updated_at = ?2
       WHERE task_id = ?1 AND status = 'scheduled'`,
      [taskId, now],
    );
    return (result.changes ?? 0) > 0;
  }

  getDueScheduledTasks(limit = 20): JobEntry[] {
    const now = new Date().toISOString();
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE status = 'scheduled'
           AND run_at IS NOT NULL
           AND julianday(run_at) <= julianday(?1)
         ORDER BY run_at ASC
         LIMIT ?2`,
      )
      .all(now, limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  getCancelableDelayedTasksForUser(userId: number, chatId: number, limit = 10): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE user_id = ?1
           AND chat_id = ?2
           AND kind = 'delayed'
           AND status IN ('scheduled', 'running', 'completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY created_at DESC
         LIMIT ?3`,
      )
      .all(userId, chatId, limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  cancelTask(taskId: string): "not_found" | "already_done" | "canceled" {
    const now = new Date().toISOString();
    const row = this.db
      .query("SELECT status FROM jobs WHERE task_id = ?1")
      .get(taskId) as { status: JobStatus } | null;
    if (!row) {
      return "not_found";
    }
    if (!["scheduled", "running", "completed_pending_delivery", "failed_pending_delivery"].includes(row.status)) {
      return "already_done";
    }
    this.db.run(
      `UPDATE jobs
       SET status = 'canceled', updated_at = ?2, delivered_at = ?2
       WHERE task_id = ?1`,
      [taskId, now],
    );
    return "canceled";
  }

  markBackgroundTaskCompleted(taskId: string, deliveryText: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE jobs
       SET status = 'completed_pending_delivery',
           updated_at = ?2,
           completed_at = ?2,
           delivery_text = ?3,
           error_message = NULL
       WHERE task_id = ?1
         AND status = 'running'`,
      [taskId, now, deliveryText],
    );
    return (result.changes ?? 0) > 0;
  }

  markBackgroundTaskFailed(taskId: string, errorMessage: string, deliveryText: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE jobs
       SET status = 'failed_pending_delivery',
           updated_at = ?2,
           completed_at = ?2,
           delivery_text = ?3,
           error_message = ?4
       WHERE task_id = ?1
         AND status = 'running'`,
      [taskId, now, deliveryText, errorMessage],
    );
    return (result.changes ?? 0) > 0;
  }

  markBackgroundTaskDelivered(taskId: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE jobs
       SET status = CASE
         WHEN status = 'failed_pending_delivery' THEN 'failed_delivered'
         ELSE 'completed_delivered'
       END,
           updated_at = ?2,
           delivered_at = ?2
       WHERE task_id = ?1
         AND status IN ('completed_pending_delivery', 'failed_pending_delivery')`,
      [taskId, now],
    );
  }

  getPendingBackgroundTasks(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY updated_at ASC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  getActiveBackgroundTasks(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE status IN ('scheduled', 'running', 'completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  getBackgroundTask(taskId: string): JobEntry | null {
    const row = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE task_id = ?1`,
      )
      .get(taskId) as JobRow | null;

    if (!row) {
      return null;
    }
    return this.mapJobRow(row);
  }

  countPendingBackgroundTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM jobs
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  countScheduledTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM jobs
         WHERE status = 'scheduled'`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  clearBackgroundTasks(): void {
    this.db.run("DELETE FROM jobs");
  }

  // Recurring job methods

  private calculateNextRunTime(recurrenceType: RecurrenceType, recurrenceExpression: string): string {
    if (recurrenceType === "interval") {
      const match = recurrenceExpression.match(/^(\d+)([mhd])$/);
      if (!match || !match[1] || !match[2]) {
        throw new Error(`Invalid interval expression: ${recurrenceExpression}`);
      }
      const amount = parseInt(match[1], 10);
      const unit = match[2];
      const next = new Date();

      switch (unit) {
        case "m":
          next.setMinutes(next.getMinutes() + amount);
          break;
        case "h":
          next.setHours(next.getHours() + amount);
          break;
        case "d":
          next.setDate(next.getDate() + amount);
          break;
        default:
          throw new Error(`Invalid time unit: ${unit}`);
      }
      return next.toISOString();
    } else if (recurrenceType === "cron") {
      // Basic cron support for common patterns
      // Format: "minute hour * * *"
      const parts = recurrenceExpression.trim().split(/\s+/);
      if (parts.length < 5) {
        throw new Error(`Invalid cron expression: ${recurrenceExpression}`);
      }

      const minute = parts[0];
      const hour = parts[1];
      if (!minute || !hour) {
        throw new Error(`Invalid cron expression: ${recurrenceExpression}`);
      }

      const next = new Date();

      // Parse hour (support basic patterns like "9" or "*/2")
      let targetHour: number;
      if (hour.startsWith("*/")) {
        const interval = parseInt(hour.slice(2), 10);
        targetHour = Math.ceil(next.getHours() / interval) * interval;
        if (targetHour >= 24) {
          targetHour = 0;
          next.setDate(next.getDate() + 1);
        }
      } else if (hour === "*") {
        targetHour = next.getHours();
      } else {
        targetHour = parseInt(hour, 10);
      }

      // Parse minute
      const targetMinute = minute === "*" ? 0 : parseInt(minute, 10);

      next.setHours(targetHour, targetMinute, 0, 0);

      // If the calculated time is in the past, move to next occurrence
      if (next <= new Date()) {
        if (hour.startsWith("*/")) {
          const interval = parseInt(hour.slice(2), 10);
          next.setHours(next.getHours() + interval);
        } else if (hour === "*") {
          next.setHours(next.getHours() + 1);
        } else {
          next.setDate(next.getDate() + 1);
        }
      }

      return next.toISOString();
    }

    throw new Error(`Unsupported recurrence type: ${recurrenceType}`);
  }

  createRecurringJob(params: {
    taskId: string;
    updateId: number;
    userId: number;
    chatId: number;
    command?: string;
    prompt: string;
    requestPreview: string;
    runAt: string;
    recurrenceType: "interval" | "cron";
    recurrenceExpression: string;
    maxRuns?: number;
  }): void {
    const now = new Date().toISOString();
    const runAtIso = new Date(params.runAt).toISOString();
    this.db.run(
      `INSERT INTO jobs (
        task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
        created_at, updated_at, timed_out_at,
        recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
      ) VALUES (?1, 'recurring', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'scheduled', ?9, ?9, ?9, ?10, ?11, ?12, 0, 1)`,
      [
        params.taskId,
        params.updateId,
        params.userId,
        params.chatId,
        params.command ?? null,
        params.prompt,
        runAtIso,
        params.requestPreview,
        now,
        params.recurrenceType,
        params.recurrenceExpression,
        params.maxRuns ?? null,
      ],
    );
  }

  rescheduleRecurringJob(taskId: string, deliveryText: string): boolean {
    const job = this.getBackgroundTask(taskId);
    if (!job || job.kind !== "recurring") {
      return false;
    }

    // Check if paused
    if (!job.recurrenceEnabled) {
      return false;
    }

    // Check max runs - increment first, then check
    const newRunCount = job.recurrenceRunCount + 1;
    if (job.recurrenceMaxRuns !== null && newRunCount > job.recurrenceMaxRuns) {
      return false; // Max runs exceeded
    }

    // Calculate next run time
    const nextRunAt = this.calculateNextRunTime(job.recurrenceType, job.recurrenceExpression!);
    const now = new Date().toISOString();

    this.db.run(
      `UPDATE jobs
       SET status = 'scheduled',
           updated_at = ?2,
           completed_at = ?2,
           run_at = ?3,
           delivery_text = ?4,
           error_message = NULL,
           recurrence_run_count = ?5
       WHERE task_id = ?1`,
      [taskId, now, nextRunAt, deliveryText, newRunCount],
    );

    return true;
  }

  recordRecurringJobFailure(taskId: string, errorMessage: string, deliveryText: string): boolean {
    const job = this.getBackgroundTask(taskId);
    if (!job || job.kind !== "recurring") {
      return false;
    }

    // Check if paused
    if (!job.recurrenceEnabled) {
      return false;
    }

    // Check max runs - increment first, then check
    const newRunCount = job.recurrenceRunCount + 1;
    if (job.recurrenceMaxRuns !== null && newRunCount > job.recurrenceMaxRuns) {
      // Max runs exceeded - mark as failed
      const now = new Date().toISOString();
      this.db.run(
        `UPDATE jobs
         SET status = 'failed_pending_delivery',
             updated_at = ?2,
             completed_at = ?2,
             delivery_text = ?3,
             error_message = ?4,
             recurrence_run_count = ?5
         WHERE task_id = ?1`,
        [taskId, now, deliveryText, errorMessage, newRunCount],
      );
      return false;
    }

    // Calculate next run time and reschedule despite failure
    const nextRunAt = this.calculateNextRunTime(job.recurrenceType, job.recurrenceExpression!);
    const now = new Date().toISOString();

    this.db.run(
      `UPDATE jobs
       SET status = 'scheduled',
           updated_at = ?2,
           completed_at = ?2,
           run_at = ?3,
           delivery_text = ?4,
           error_message = ?5,
           recurrence_run_count = ?6
       WHERE task_id = ?1`,
      [taskId, now, nextRunAt, deliveryText, errorMessage, newRunCount],
    );

    return true;
  }

  pauseRecurringJob(taskId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_enabled = 0,
           updated_at = ?2
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [taskId, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  resumeRecurringJob(taskId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_enabled = 1,
           updated_at = ?2
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [taskId, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  getRecurringJobs(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled
         FROM jobs
         WHERE kind = 'recurring'
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  updateRecurrenceExpression(taskId: string, expression: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_expression = ?2,
           updated_at = ?3
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [taskId, expression, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  cancelRecurringJob(taskId: string): "not_found" | "already_done" | "canceled" {
    return this.cancelTask(taskId);
  }
}
