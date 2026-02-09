import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

export type ConversationEntry = { role: "user" | "assistant"; text: string };
export type ConversationStats = { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean };
export type RecentMessageEntry = { createdAt: string; role: "user" | "assistant"; summary: string };
export type BackgroundTaskStatus =
  | "scheduled"
  | "running"
  | "completed_pending_delivery"
  | "completed_delivered"
  | "failed_pending_delivery"
  | "failed_delivered"
  | "canceled";
export type TaskKind = "background" | "delayed";
export type BackgroundTaskEntry = {
  taskId: string;
  kind: TaskKind;
  updateId: number;
  userId: number;
  chatId: number;
  command: string | null;
  payloadPrompt: string | null;
  runAt: string | null;
  requestPreview: string;
  status: BackgroundTaskStatus;
  createdAt: string;
  timedOutAt: string;
  completedAt: string | null;
  deliveredAt: string | null;
  deliveryText: string | null;
  errorMessage: string | null;
};

type RuntimeRow = { value: string };
type ConversationRow = { role: "user" | "assistant"; text: string };
type RecentRow = { created_at: string; role: "user" | "assistant"; summary: string };
type BackgroundTaskRow = {
  task_id: string;
  kind: TaskKind;
  update_id: number;
  user_id: number;
  chat_id: number;
  command: string | null;
  payload_prompt: string | null;
  run_at: string | null;
  request_preview: string;
  status: BackgroundTaskStatus;
  created_at: string;
  timed_out_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  delivery_text: string | null;
  error_message: string | null;
};

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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS background_tasks (
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
        error_message TEXT
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_background_status ON background_tasks(status, updated_at);");
    this.ensureBackgroundTaskColumns();
    this.db.run("CREATE INDEX IF NOT EXISTS idx_background_due ON background_tasks(status, run_at);");
  }

  private ensureBackgroundTaskColumns(): void {
    try {
      this.db.run("ALTER TABLE background_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'background'");
    } catch {
      // already present
    }
    try {
      this.db.run("ALTER TABLE background_tasks ADD COLUMN payload_prompt TEXT");
    } catch {
      // already present
    }
    try {
      this.db.run("ALTER TABLE background_tasks ADD COLUMN run_at TEXT");
    } catch {
      // already present
    }
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
      `INSERT INTO background_tasks (
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
      `INSERT INTO background_tasks (
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
      `UPDATE background_tasks
       SET status = 'running', updated_at = ?2
       WHERE task_id = ?1 AND status = 'scheduled'`,
      [taskId, now],
    );
    return (result.changes ?? 0) > 0;
  }

  getDueScheduledTasks(limit = 20): BackgroundTaskEntry[] {
    const now = new Date().toISOString();
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message
         FROM background_tasks
         WHERE status = 'scheduled'
           AND run_at IS NOT NULL
           AND julianday(run_at) <= julianday(?1)
         ORDER BY run_at ASC
         LIMIT ?2`,
      )
      .all(now, limit) as BackgroundTaskRow[];

    return rows.map((row) => ({
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
    }));
  }

  getCancelableDelayedTasksForUser(userId: number, chatId: number, limit = 10): BackgroundTaskEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message
         FROM background_tasks
         WHERE user_id = ?1
           AND chat_id = ?2
           AND kind = 'delayed'
           AND status IN ('scheduled', 'running', 'completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY created_at DESC
         LIMIT ?3`,
      )
      .all(userId, chatId, limit) as BackgroundTaskRow[];

    return rows.map((row) => ({
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
    }));
  }

  cancelTask(taskId: string): "not_found" | "already_done" | "canceled" {
    const now = new Date().toISOString();
    const row = this.db
      .query("SELECT status FROM background_tasks WHERE task_id = ?1")
      .get(taskId) as { status: BackgroundTaskStatus } | null;
    if (!row) {
      return "not_found";
    }
    if (!["scheduled", "running", "completed_pending_delivery", "failed_pending_delivery"].includes(row.status)) {
      return "already_done";
    }
    this.db.run(
      `UPDATE background_tasks
       SET status = 'canceled', updated_at = ?2, delivered_at = ?2
       WHERE task_id = ?1`,
      [taskId, now],
    );
    return "canceled";
  }

  markBackgroundTaskCompleted(taskId: string, deliveryText: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE background_tasks
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
      `UPDATE background_tasks
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
      `UPDATE background_tasks
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

  getPendingBackgroundTasks(limit = 20): BackgroundTaskEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message
         FROM background_tasks
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY updated_at ASC
         LIMIT ?1`,
      )
      .all(limit) as BackgroundTaskRow[];

    return rows.map((row) => ({
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
    }));
  }

  getActiveBackgroundTasks(limit = 20): BackgroundTaskEntry[] {
    const rows = this.db
      .query(
        `SELECT task_id, update_id, user_id, chat_id, command, request_preview, status,
                kind, payload_prompt, run_at,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message
         FROM background_tasks
         WHERE status IN ('scheduled', 'running', 'completed_pending_delivery', 'failed_pending_delivery')
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit) as BackgroundTaskRow[];

    return rows.map((row) => ({
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
    }));
  }

  getBackgroundTask(taskId: string): BackgroundTaskEntry | null {
    const row = this.db
      .query(
        `SELECT task_id, kind, update_id, user_id, chat_id, command, payload_prompt, run_at, request_preview, status,
                created_at, timed_out_at, completed_at, delivered_at, delivery_text, error_message
         FROM background_tasks
         WHERE task_id = ?1`,
      )
      .get(taskId) as BackgroundTaskRow | null;

    if (!row) {
      return null;
    }
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
    };
  }

  countPendingBackgroundTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM background_tasks
         WHERE status IN ('completed_pending_delivery', 'failed_pending_delivery')`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  countScheduledTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total
         FROM background_tasks
         WHERE status = 'scheduled'`,
      )
      .get() as { total: number } | null;
    return row?.total ?? 0;
  }

  clearBackgroundTasks(): void {
    this.db.run("DELETE FROM background_tasks");
  }
}
