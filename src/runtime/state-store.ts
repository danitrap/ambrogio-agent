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
  | "canceled"
  | "skipped_muted";
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
  mutedUntil: string | null;
};

// Type aliases for backwards compatibility
/** @deprecated Use JobStatus instead */
export type BackgroundTaskStatus = JobStatus;
/** @deprecated Use JobKind instead */
export type TaskKind = JobKind;
/** @deprecated Use JobEntry instead */
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
  muted_until: string | null;
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
      mutedUntil: row.muted_until,
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

    // Add muted_until column (migration for existing databases)
    const mutedUntilColumnExists = this.db
      .query("SELECT COUNT(*) as count FROM pragma_table_info('jobs') WHERE name='muted_until'")
      .get() as { count: number };

    if (mutedUntilColumnExists.count === 0) {
      this.db.run("ALTER TABLE jobs ADD COLUMN muted_until TEXT NULL");
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

  createBackgroundJob(params: {
    jobId: string;
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
        params.jobId,
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

  createScheduledJob(params: {
    jobId: string;
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
        params.jobId,
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

  createDelayedJob(params: {
    jobId: string;
    updateId: number;
    userId: number;
    chatId: number;
    prompt: string;
    requestPreview: string;
    runAt: string;
    mutedUntil?: string | null;
  }): void {
    const now = new Date().toISOString();
    const runAtIso = new Date(params.runAt).toISOString();
    this.db.run(
      `INSERT INTO jobs (
        task_id, kind, update_id, user_id, chat_id, command, payload_prompt,
        run_at, request_preview, status, created_at, updated_at, timed_out_at,
        recurrence_type, recurrence_expression, recurrence_max_runs,
        recurrence_run_count, recurrence_enabled, muted_until
      ) VALUES (?1, 'delayed', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'scheduled', ?9, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      [
        params.jobId,
        params.updateId,
        params.userId,
        params.chatId,
        null,
        params.prompt,
        runAtIso,
        params.requestPreview,
        now,
        null,
        null,
        null,
        0,
        1,
        params.mutedUntil ?? null,
      ],
    );
  }

  claimScheduledJob(jobId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE jobs
       SET status = 'running', updated_at = ?2
       WHERE task_id = ?1 AND status = 'scheduled'`,
      [jobId, now],
    );
    return (result.changes ?? 0) > 0;
  }

  getDueScheduledJobs(limit = 20): JobEntry[] {
    const now = new Date().toISOString();
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
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

  getCancelableDelayedJobsForUser(userId: number, chatId: number, limit = 10): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
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

  cancelJob(jobId: string): "not_found" | "already_done" | "canceled" {
    const now = new Date().toISOString();
    const row = this.db
      .query("SELECT status FROM jobs WHERE task_id = ?1")
      .get(jobId) as { status: JobStatus } | null;
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
      [jobId, now],
    );
    return "canceled";
  }

  markBackgroundJobCompleted(jobId: string, deliveryText: string): boolean {
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
      [jobId, now, deliveryText],
    );
    return (result.changes ?? 0) > 0;
  }

  markBackgroundJobFailed(jobId: string, errorMessage: string, deliveryText: string): boolean {
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
      [jobId, now, deliveryText, errorMessage],
    );
    return (result.changes ?? 0) > 0;
  }

  markBackgroundJobDelivered(jobId: string): void {
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
      [jobId, now],
    );
  }

  markJobSkippedMuted(taskId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs SET status = ?, completed_at = ?
       WHERE task_id = ? AND status IN ('scheduled', 'running')`,
      ["skipped_muted", new Date().toISOString(), taskId],
    );
    return (result.changes ?? 0) > 0;
  }

  muteJob(taskId: string, mutedUntil: string): boolean {
    const result = this.db.run(
      `UPDATE jobs SET muted_until = ? WHERE task_id = ?`,
      [mutedUntil, taskId],
    );
    return (result.changes ?? 0) > 0;
  }

  unmuteJob(taskId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs SET muted_until = NULL WHERE task_id = ?`,
      [taskId],
    );
    return (result.changes ?? 0) > 0;
  }

  muteJobsByPattern(pattern: string, mutedUntil: string): number {
    const result = this.db.run(
      `UPDATE jobs
       SET muted_until = ?
       WHERE (payload_prompt LIKE ? OR request_preview LIKE ?)
       AND status IN ('scheduled', 'running')`,
      [mutedUntil, `%${pattern}%`, `%${pattern}%`],
    );
    return result.changes ?? 0;
  }

  getMutedJobs(limit = 50): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
         FROM jobs
         WHERE muted_until IS NOT NULL
         AND muted_until > datetime('now')
         ORDER BY muted_until ASC
         LIMIT ?`,
      )
      .all(limit) as JobRow[];
    return rows.map((row) => this.mapJobRow(row));
  }

  getPendingBackgroundJobs(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
         FROM jobs
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY updated_at ASC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  getActiveBackgroundJobs(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
         FROM jobs
         WHERE status IN ('scheduled', 'running', 'completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  getBackgroundJob(jobId: string): JobEntry | null {
    const row = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
         FROM jobs
         WHERE task_id = ?1`,
      )
      .get(jobId) as JobRow | null;

    if (!row) {
      return null;
    }
    return this.mapJobRow(row);
  }

  countPendingBackgroundJobs(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM jobs
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  countScheduledJobs(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM jobs
         WHERE status = 'scheduled'`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  clearBackgroundJobs(): void {
    this.db.run("DELETE FROM jobs");
  }

  // Recurring job methods

  private validateCronExpression(expr: string): void {
    const parts = expr.trim().split(/\s+/);

    // Require exactly 5 fields
    if (parts.length !== 5) {
      throw new Error(`BAD_REQUEST: Cron expression must have exactly 5 fields (minute hour day month day-of-week), got ${parts.length}. Example: '0 9 * * *'`);
    }

    const [minute, hour, day, month, dayOfWeek] = parts;
    if (!minute || !hour || !day || !month || !dayOfWeek) {
      throw new Error("BAD_REQUEST: Cron expression has empty fields. Example: '0 9 * * *'");
    }

    // Validate minute (0-59, *, or */N)
    if (minute !== "*" && !minute.startsWith("*/")) {
      const m = parseInt(minute, 10);
      if (Number.isNaN(m) || m < 0 || m > 59) {
        throw new Error(`BAD_REQUEST: Invalid minute value: '${minute}' (must be 0-59, *, or */N). Example: '30 9 * * *'`);
      }
    } else if (minute.startsWith("*/")) {
      const interval = parseInt(minute.slice(2), 10);
      if (Number.isNaN(interval) || interval <= 0) {
        throw new Error(`BAD_REQUEST: Invalid minute interval: '${minute}'. Example: '*/15 * * * *'`);
      }
    }

    // Validate hour (0-23, *, or */N)
    if (hour !== "*" && !hour.startsWith("*/")) {
      const h = parseInt(hour, 10);
      if (Number.isNaN(h) || h < 0 || h > 23) {
        throw new Error(`BAD_REQUEST: Invalid hour value: '${hour}' (must be 0-23, *, or */N). Example: '0 14 * * *'`);
      }
    } else if (hour.startsWith("*/")) {
      const interval = parseInt(hour.slice(2), 10);
      if (Number.isNaN(interval) || interval <= 0) {
        throw new Error(`BAD_REQUEST: Invalid hour interval: '${hour}'. Example: '0 */2 * * *'`);
      }
    }

    // Validate day-of-month (1-31, L, *, ranges, lists)
    if (day !== "*" && day !== "L") {
      for (const part of day.split(",")) {
        const trimmedPart = part.trim();
        if (trimmedPart.includes("-")) {
          // Range validation
          const range = trimmedPart.split("-");
          if (range.length !== 2) {
            throw new Error(`BAD_REQUEST: Invalid day-of-month range: '${trimmedPart}'. Example: '1-7' for first week`);
          }
          const start = parseInt(range[0]?.trim() ?? "", 10);
          const end = parseInt(range[1]?.trim() ?? "", 10);
          if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || start > 31 || end < 1 || end > 31) {
            throw new Error(`BAD_REQUEST: Invalid day-of-month range: '${trimmedPart}' (must be 1-31). Example: '1-7'`);
          }
          if (start > end) {
            throw new Error(`BAD_REQUEST: Invalid day-of-month range: '${trimmedPart}' (start must be ≤ end)`);
          }
        } else {
          // Single value validation
          const d = parseInt(trimmedPart, 10);
          if (Number.isNaN(d) || d < 1 || d > 31) {
            throw new Error(`BAD_REQUEST: Invalid day-of-month value: '${trimmedPart}' (must be 1-31, L, *, or range/list). Example: '15' for 15th of month`);
          }
        }
      }
    }

    // Validate month (1-12, JAN-DEC, *, ranges, lists)
    if (month !== "*") {
      for (const part of month.split(",")) {
        const trimmedPart = part.trim();
        if (trimmedPart.includes("-")) {
          // Range validation
          const range = trimmedPart.split("-");
          if (range.length !== 2) {
            throw new Error(`BAD_REQUEST: Invalid month range: '${trimmedPart}'. Example: '1-6' for Jan-Jun`);
          }
          const start = this.parseMonthValue(range[0]?.trim() ?? "");
          const end = this.parseMonthValue(range[1]?.trim() ?? "");
          if (start < 1 || start > 12 || end < 1 || end > 12) {
            throw new Error(`BAD_REQUEST: Invalid month range: '${trimmedPart}' (must be 1-12 or JAN-DEC)`);
          }
          if (start > end) {
            throw new Error(`BAD_REQUEST: Invalid month range: '${trimmedPart}' (start must be ≤ end)`);
          }
        } else {
          // Single value validation
          const m = this.parseMonthValue(trimmedPart);
          if (m < 1 || m > 12) {
            throw new Error(`BAD_REQUEST: Invalid month value: '${trimmedPart}' (must be 1-12, JAN-DEC, *, or range/list). Example: 'JAN' or '1'`);
          }
        }
      }
    }

    // Validate day-of-week (0-7, ranges, comma-separated lists)
    if (dayOfWeek !== "*") {
      for (const part of dayOfWeek.split(",")) {
        const trimmedPart = part.trim();
        if (trimmedPart.includes("-")) {
          // Range validation (e.g., "1-5" for Mon-Fri)
          const range = trimmedPart.split("-");
          if (range.length !== 2) {
            throw new Error(`BAD_REQUEST: Invalid day-of-week range: '${trimmedPart}'. Example: '1-5' for Mon-Fri`);
          }
          const start = parseInt(range[0]?.trim() ?? "", 10);
          const end = parseInt(range[1]?.trim() ?? "", 10);
          if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > 7 || end < 0 || end > 7) {
            throw new Error(`BAD_REQUEST: Invalid day-of-week range: '${trimmedPart}' (must be 0-7). Example: '1-5' for Mon-Fri`);
          }
          if (start > end) {
            throw new Error(`BAD_REQUEST: Invalid day-of-week range: '${trimmedPart}' (start must be ≤ end). Example: '1-5' not '5-1'`);
          }
        } else {
          // Single value validation
          const d = parseInt(trimmedPart, 10);
          if (Number.isNaN(d) || d < 0 || d > 7) {
            throw new Error(`BAD_REQUEST: Invalid day-of-week value: '${trimmedPart}' (must be 0-7, where 0=Sunday, 6=Saturday, 7=Sunday). Example: '0 9 * * 1-5' for weekdays`);
          }
        }
      }
    }
  }

  private parseMonthValue(value: string): number {
    const monthNames: { [key: string]: number } = {
      'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4,
      'MAY': 5, 'JUN': 6, 'JUL': 7, 'AUG': 8,
      'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
    };

    const upper = value.toUpperCase();
    return monthNames[upper] ?? parseInt(value, 10);
  }

  private parseDayOfMonthField(dayOfMonth: string): number[] | 'L' | null {
    if (dayOfMonth === '*') return null;
    if (dayOfMonth === 'L') return 'L';  // Special marker for last day of month

    const days: number[] = [];

    for (const part of dayOfMonth.split(',')) {
      const trimmedPart = part.trim();
      if (trimmedPart.includes('-')) {
        // Range: "1-7" for first week
        const [start, end] = trimmedPart.split('-').map(d => parseInt(d.trim(), 10));
        if (start !== undefined && end !== undefined) {
          for (let d = start; d <= end; d++) {
            days.push(d);
          }
        }
      } else {
        days.push(parseInt(trimmedPart, 10));
      }
    }

    return days;
  }

  private parseMonthField(month: string): number[] | null {
    if (month === '*') return null;

    const months: number[] = [];

    for (const part of month.split(',')) {
      const trimmedPart = part.trim();
      if (trimmedPart.includes('-')) {
        // Range: "1-6" or "JAN-JUN"
        const [start, end] = trimmedPart.split('-');
        const startMonth = this.parseMonthValue(start?.trim() ?? "");
        const endMonth = this.parseMonthValue(end?.trim() ?? "");
        for (let m = startMonth; m <= endMonth; m++) {
          months.push(m);
        }
      } else {
        months.push(this.parseMonthValue(trimmedPart));
      }
    }

    return months;
  }

  private getDaysInMonth(year: number, month: number): number {
    // month is 1-12 (not 0-11 like JavaScript Date)
    return new Date(year, month, 0).getDate();
  }

  private validateIntervalExpression(expr: string): void {
    const match = expr.match(/^(\d+)([mhd])$/);

    if (!match || !match[1] || !match[2]) {
      throw new Error(`BAD_REQUEST: Invalid interval format: '${expr}' (expected format: <number><unit> where unit is m, h, or d). Example: '30m', '2h', '7d'`);
    }

    const amountStr = match[1];
    const unit = match[2];
    const amount = parseInt(amountStr, 10);

    // Validate amount is positive
    if (Number.isNaN(amount) || amount <= 0) {
      throw new Error(`BAD_REQUEST: Interval amount must be positive, got: ${expr}. Example: '30m' not '0m'`);
    }

    // Validate unit
    if (unit !== 'm' && unit !== 'h' && unit !== 'd') {
      throw new Error(`BAD_REQUEST: Invalid interval unit: '${unit}' (must be 'm' for minutes, 'h' for hours, or 'd' for days). Example: '30m'`);
    }

    // Validate reasonable limits to prevent overflow
    const limits = {
      m: 525600,  // 1 year in minutes
      h: 8760,    // 1 year in hours
      d: 365,     // 1 year in days
    };

    const maxAmount = limits[unit];
    if (amount > maxAmount) {
      throw new Error(`BAD_REQUEST: Interval too large: ${amount}${unit} (maximum: ${maxAmount}${unit}). Consider using a larger time unit.`);
    }
  }

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
      // Full cron support with day-of-month and month constraints
      // Format: "minute hour day month day-of-week"
      const parts = recurrenceExpression.trim().split(/\s+/);
      if (parts.length < 5) {
        throw new Error(`Invalid cron expression: ${recurrenceExpression}`);
      }

      const minute = parts[0];
      const hour = parts[1];
      const dayOfMonth = parts[2];
      const month = parts[3];
      const dayOfWeek = parts[4];

      if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
        throw new Error(`Invalid cron expression: ${recurrenceExpression}`);
      }

      const now = new Date();
      let next = new Date();

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

      // Parse day-of-month and month constraints
      const allowedDaysOfMonth = this.parseDayOfMonthField(dayOfMonth);
      const allowedMonths = this.parseMonthField(month);

      // Parse day-of-week (existing logic)
      let allowedDaysOfWeek: number[] | null = null;
      if (dayOfWeek && dayOfWeek !== "*") {
        const allowedDays: number[] = [];
        for (const part of dayOfWeek.split(",")) {
          if (part.includes("-")) {
            const [start, end] = part.split("-").map((d) => parseInt(d.trim(), 10));
            if (start !== undefined && end !== undefined) {
              for (let d = start; d <= end; d++) {
                allowedDays.push(d === 7 ? 0 : d); // Convert 7 to 0 (both represent Sunday)
              }
            }
          } else {
            const day = parseInt(part.trim(), 10);
            allowedDays.push(day === 7 ? 0 : day);
          }
        }
        allowedDaysOfWeek = allowedDays;
      }

      // Set initial time
      next.setHours(targetHour, targetMinute, 0, 0);

      // Advance if time already passed
      if (next <= now) {
        if (hour.startsWith("*/")) {
          const interval = parseInt(hour.slice(2), 10);
          next.setHours(next.getHours() + interval);
        } else if (hour === "*") {
          next.setHours(next.getHours() + 1);
        } else {
          next.setDate(next.getDate() + 1);
        }
      }

      // Find next valid date with all constraints
      let attempts = 0;
      const maxAttempts = 732; // 2 years to handle month/day-of-month combinations

      while (attempts < maxAttempts) {
        const nextYear = next.getFullYear();
        const nextMonth = next.getMonth() + 1; // 1-12
        const nextDayOfMonth = next.getDate();
        const nextDayOfWeek = next.getDay(); // 0-6

        // Check month constraint
        const monthValid = !allowedMonths || allowedMonths.includes(nextMonth);

        // Check day-of-month constraint (with month boundary handling)
        let dayOfMonthValid = true;
        if (allowedDaysOfMonth !== null) {
          const daysInMonth = this.getDaysInMonth(nextYear, nextMonth);

          if (allowedDaysOfMonth === 'L') {
            // Last day of month
            dayOfMonthValid = (nextDayOfMonth === daysInMonth);
          } else {
            // Filter days that exist in this month (e.g., skip 31 in April)
            const validDays = allowedDaysOfMonth.filter(d => d <= daysInMonth);
            dayOfMonthValid = validDays.includes(nextDayOfMonth);
          }
        }

        // Check day-of-week constraint
        const dayOfWeekValid = !allowedDaysOfWeek || allowedDaysOfWeek.includes(nextDayOfWeek);

        // Apply OR logic: if both day constraints exist, accept either
        const hasDayOfMonth = allowedDaysOfMonth !== null;
        const hasDayOfWeek = allowedDaysOfWeek !== null;

        let dayValid: boolean;
        if (hasDayOfMonth && hasDayOfWeek) {
          // Both specified: OR logic (traditional cron behavior)
          dayValid = dayOfMonthValid || dayOfWeekValid;
        } else if (hasDayOfMonth) {
          dayValid = dayOfMonthValid;
        } else if (hasDayOfWeek) {
          dayValid = dayOfWeekValid;
        } else {
          dayValid = true; // No day constraints
        }

        // Accept if all constraints met and in future
        if (monthValid && dayValid && next > now) {
          return next.toISOString();
        }

        // Advance to next day
        next.setDate(next.getDate() + 1);
        next.setHours(targetHour, targetMinute, 0, 0);
        attempts++;
      }

      throw new Error(`Could not find next run time within 2 years for cron expression: ${recurrenceExpression}`);
    }

    throw new Error(`Unsupported recurrence type: ${recurrenceType}`);
  }

  /**
   * Creates a recurring job with interval or cron scheduling.
   *
   * Cron format: "minute hour day-of-month month day-of-week"
   *
   * Supported cron features:
   * - Minute: 0-59, wildcard, intervals, ranges, lists
   * - Hour: 0-23, wildcard, intervals, ranges, lists
   * - Day-of-month: 1-31, L (last day), wildcard, ranges, lists
   * - Month: 1-12, JAN-DEC, wildcard, ranges, lists
   * - Day-of-week: 0-7 (0 and 7 are Sunday), wildcard, ranges, lists
   *
   * Day constraint logic:
   * When both day-of-month and day-of-week are specified, uses OR logic (traditional cron).
   * For example, "0 9 15 1" runs on the 15th OR Mondays, not just when 15th is a Monday.
   *
   * Month boundaries:
   * - Day 31 in 30-day months: Skips those months (Apr, Jun, Sep, Nov)
   * - Day 30-31 in February: Skips February entirely
   * - February 29: Only runs on leap years
   * - Last day "L": Runs on 28/29/30/31 depending on month length
   *
   * Cron examples:
   * - "0 9 1 wildcard wildcard" - 1st of every month at 9am
   * - "0 9 15 wildcard wildcard" - 15th of every month at 9am
   * - "0 17 L wildcard wildcard" - Last day of month at 5pm
   * - "0 9 wildcard 1-6 wildcard" - Every day Jan-Jun at 9am
   * - "0 0 1 1 wildcard" - New Year (Jan 1st midnight)
   *
   * Interval format: number + unit (m=minutes, h=hours, d=days)
   * - Maximum intervals: 525600m, 8760h, 365d (1 year)
   * - Examples: "30m" (every 30 minutes), "2h" (every 2 hours), "7d" (every 7 days)
   *
   * Timezone: All times interpreted in system local timezone
   *
   * @throws Error with BAD_REQUEST prefix for invalid expressions
   */
  createRecurringJob(params: {
    jobId: string;
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
    mutedUntil?: string | null;
  }): void {
    const now = new Date().toISOString();

    // Validate expression before processing
    if (params.recurrenceType === "cron") {
      this.validateCronExpression(params.recurrenceExpression);
    } else if (params.recurrenceType === "interval") {
      this.validateIntervalExpression(params.recurrenceExpression);
    } else {
      throw new Error(`BAD_REQUEST: Invalid recurrence type: '${params.recurrenceType}' (must be 'interval' or 'cron')`);
    }

    // For cron jobs with day-of-week constraints, validate that runAt matches the schedule
    // If not, calculate the next valid run time
    let runAtIso: string;
    if (params.recurrenceType === "cron") {
      // Check if the provided runAt matches the cron expression
      const providedDate = new Date(params.runAt);
      const parts = params.recurrenceExpression.trim().split(/\s+/);

      if (parts.length >= 5 && parts[4] && parts[4] !== "*") {
        // Has day-of-week constraint
        const dayOfWeek = parts[4];
        const allowedDays: number[] = [];

        for (const part of dayOfWeek.split(",")) {
          if (part.includes("-")) {
            const [start, end] = part.split("-").map((d) => parseInt(d.trim(), 10));
            if (start !== undefined && end !== undefined) {
              for (let d = start; d <= end; d++) {
                allowedDays.push(d === 7 ? 0 : d);
              }
            }
          } else {
            const day = parseInt(part.trim(), 10);
            allowedDays.push(day === 7 ? 0 : day);
          }
        }

        const currentDay = providedDate.getDay();
        if (!allowedDays.includes(currentDay) || providedDate <= new Date()) {
          // Provided date doesn't match constraint or is in the past, calculate next valid run
          runAtIso = this.calculateNextRunTime(params.recurrenceType, params.recurrenceExpression);
        } else {
          runAtIso = new Date(params.runAt).toISOString();
        }
      } else {
        // No day-of-week constraint or wildcard, use provided date or calculate next
        runAtIso = new Date(params.runAt) <= new Date()
          ? this.calculateNextRunTime(params.recurrenceType, params.recurrenceExpression)
          : new Date(params.runAt).toISOString();
      }
    } else {
      // For interval-based jobs, use the provided date
      runAtIso = new Date(params.runAt).toISOString();
    }

    this.db.run(
      `INSERT INTO jobs (
        task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
        created_at, updated_at, timed_out_at,
        recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
      ) VALUES (?1, 'recurring', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'scheduled', ?9, ?9, ?9, ?10, ?11, ?12, 0, 1, ?13)`,
      [
        params.jobId,
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
        params.mutedUntil ?? null,
      ],
    );
  }

  rescheduleRecurringJob(jobId: string, deliveryText: string): boolean {
    const job = this.getBackgroundJob(jobId);
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
      [jobId, now, nextRunAt, deliveryText, newRunCount],
    );

    return true;
  }

  recordRecurringJobFailure(jobId: string, errorMessage: string, deliveryText: string): boolean {
    const job = this.getBackgroundJob(jobId);
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
        [jobId, now, deliveryText, errorMessage, newRunCount],
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
      [jobId, now, nextRunAt, deliveryText, errorMessage, newRunCount],
    );

    return true;
  }

  pauseRecurringJob(jobId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_enabled = 0,
           updated_at = ?2
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [jobId, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  resumeRecurringJob(jobId: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_enabled = 1,
           updated_at = ?2
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [jobId, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  getRecurringJobs(limit = 20): JobEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message,
                recurrence_type, recurrence_expression, recurrence_max_runs, recurrence_run_count, recurrence_enabled, muted_until
         FROM jobs
         WHERE kind = 'recurring'
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit) as JobRow[];

    return rows.map((row) => this.mapJobRow(row));
  }

  updateRecurrenceExpression(jobId: string, expression: string): boolean {
    // Fetch job to determine type, then validate
    const job = this.getBackgroundJob(jobId);
    if (!job || job.kind !== 'recurring') {
      return false;
    }

    // Validate based on the job's recurrence type
    if (job.recurrenceType === "cron") {
      this.validateCronExpression(expression);
    } else if (job.recurrenceType === "interval") {
      this.validateIntervalExpression(expression);
    }

    const result = this.db.run(
      `UPDATE jobs
       SET recurrence_expression = ?2,
           updated_at = ?3
       WHERE task_id = ?1 AND kind = 'recurring'`,
      [jobId, expression, new Date().toISOString()],
    );
    return (result.changes ?? 0) > 0;
  }

  cancelRecurringJob(jobId: string): "not_found" | "already_done" | "canceled" {
    return this.cancelJob(jobId);
  }
}
