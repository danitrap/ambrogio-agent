import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

export type ConversationEntry = { role: "user" | "assistant"; text: string };
export type ConversationStats = { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean };
export type RecentMessageEntry = { createdAt: string; role: "user" | "assistant"; summary: string };

type RuntimeRow = { value: string };
type ConversationRow = { role: "user" | "assistant"; text: string };
type RecentRow = { created_at: string; role: "user" | "assistant"; summary: string };

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
}
