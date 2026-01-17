import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "fs";
import { getConfig, debugLog } from "./config";
import type { SessionRecord, MessageRecord, ToolCallRecord } from "./types";

// Cache of databases by path - supports multiple project-specific databases
const databases = new Map<string, Database>();

const SCHEMA = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'interrupted')),
    summary TEXT,
    message_count INTEGER DEFAULT 0,
    interface TEXT DEFAULT 'cli' CHECK(interface IN ('cli', 'vscode', 'web')),
    markdown_path TEXT
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    tool_output TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Tool calls table (for analytics)
CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id INTEGER,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_summary TEXT,
    success INTEGER,
    duration_ms INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (message_id) REFERENCES messages(id)
);

-- Events table (notifications, permission requests, compactions, etc.)
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('notification', 'permission_request', 'pre_compact', 'subagent_stop')),
    subtype TEXT,
    tool_name TEXT,
    message TEXT,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Transcript backups (for PreCompact)
CREATE TABLE IF NOT EXISTS transcript_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    trigger TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    backup_path TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`;

/**
 * Opens (or creates) the SQLite database, with graceful handling of corruption.
 * If the database file is corrupt, it's backed up and a fresh database is created.
 */
export function getDatabase(customDbPath?: string | null): Database {
  const config = getConfig();
  const dbPath = customDbPath || config.dbPath;

  // Check cache first
  const cached = databases.get(dbPath);
  if (cached) {
    return cached;
  }

  debugLog("Opening database at:", dbPath);

  let db: Database;
  try {
    db = openAndInitializeDatabase(dbPath, config.enableWAL);
  } catch (error) {
    // Database might be corrupt - attempt recovery
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[claude-remember] Database error: ${errorMessage}`);

    if (existsSync(dbPath)) {
      // Backup the corrupt database
      const backupPath = `${dbPath}.corrupt.${Date.now()}`;
      try {
        renameSync(dbPath, backupPath);
        console.error(`[claude-remember] Backed up corrupt database to: ${backupPath}`);

        // Also backup any WAL/SHM files
        const walPath = `${dbPath}-wal`;
        const shmPath = `${dbPath}-shm`;
        if (existsSync(walPath)) {
          renameSync(walPath, `${backupPath}-wal`);
        }
        if (existsSync(shmPath)) {
          renameSync(shmPath, `${backupPath}-shm`);
        }
      } catch (backupError) {
        console.error(`[claude-remember] Failed to backup corrupt database: ${backupError}`);
      }

      // Try to create a fresh database
      try {
        db = openAndInitializeDatabase(dbPath, config.enableWAL);
        console.error("[claude-remember] Created fresh database after corruption recovery");
      } catch (retryError) {
        // If we still can't create a database, re-throw
        throw new Error(`Failed to recover from database corruption: ${retryError}`);
      }
    } else {
      // No existing file, re-throw original error
      throw error;
    }
  }

  // Cache the database
  databases.set(dbPath, db);

  return db;
}

/**
 * Opens a database and initializes the schema.
 * Throws if the database is corrupt or unreadable.
 */
function openAndInitializeDatabase(dbPath: string, enableWAL: boolean): Database {
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent access
  if (enableWAL) {
    db.run("PRAGMA journal_mode = WAL");
  }

  // Run an integrity check on existing databases to catch corruption early
  // Skip this for new databases (no tables yet)
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
  if (tables.length > 0) {
    const integrityResult = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (integrityResult && integrityResult.integrity_check !== "ok") {
      db.close();
      throw new Error(`Database integrity check failed: ${integrityResult.integrity_check}`);
    }
  }

  // Create tables
  db.run(SCHEMA);

  // Migration: add markdown_path column if it doesn't exist (for existing databases)
  try {
    db.run("ALTER TABLE sessions ADD COLUMN markdown_path TEXT");
  } catch (e) {
    // Column already exists, ignore
  }

  return db;
}

export function closeDatabase(): void {
  for (const [path, db] of databases) {
    debugLog("Closing database:", path);
    db.close();
  }
  databases.clear();
}

// Session operations
export function createSession(session: Omit<SessionRecord, "ended_at" | "summary" | "message_count" | "markdown_path"> & { markdown_path?: string | null }, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, project_path, started_at, status, interface, markdown_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.project_path,
    session.started_at,
    session.status,
    session.interface,
    session.markdown_path || null
  );
  debugLog("Created session:", session.id);
}

export function updateSessionMarkdownPath(sessionId: string, markdownPath: string, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    UPDATE sessions
    SET markdown_path = ?
    WHERE id = ?
  `);
  stmt.run(markdownPath, sessionId);
  debugLog("Updated session markdown path:", sessionId, markdownPath);
}

export function getSessionMarkdownPath(sessionId: string, dbPath?: string | null): string | null {
  const db = getDatabase(dbPath);
  const stmt = db.prepare("SELECT markdown_path FROM sessions WHERE id = ?");
  const result = stmt.get(sessionId) as { markdown_path: string | null } | null;
  return result?.markdown_path || null;
}

export function updateSessionEnd(sessionId: string, reason: string, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  const status = reason === "logout" || reason === "prompt_input_exit" ? "completed" : "interrupted";
  const stmt = db.prepare(`
    UPDATE sessions
    SET ended_at = ?, status = ?
    WHERE id = ?
  `);
  stmt.run(new Date().toISOString(), status, sessionId);
  debugLog("Updated session end:", sessionId, status);
}

export function getSession(sessionId: string, dbPath?: string | null): SessionRecord | null {
  const db = getDatabase(dbPath);
  const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  return stmt.get(sessionId) as SessionRecord | null;
}

export function incrementMessageCount(sessionId: string, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    UPDATE sessions
    SET message_count = message_count + 1
    WHERE id = ?
  `);
  stmt.run(sessionId);
}

// Message operations
export function insertMessage(message: MessageRecord, dbPath?: string | null): number {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, timestamp, role, content, tool_name, tool_input, tool_output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    message.session_id,
    message.timestamp,
    message.role,
    message.content,
    message.tool_name,
    message.tool_input,
    message.tool_output
  );

  incrementMessageCount(message.session_id, dbPath);
  debugLog("Inserted message:", message.role, "for session:", message.session_id);

  return Number(result.lastInsertRowid);
}

export function getSessionMessages(sessionId: string, dbPath?: string | null): MessageRecord[] {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(sessionId) as MessageRecord[];
}

// Tool call operations
export function insertToolCall(toolCall: ToolCallRecord, dbPath?: string | null): number {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    INSERT INTO tool_calls (session_id, message_id, timestamp, tool_name, input_summary, success, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    toolCall.session_id,
    toolCall.message_id,
    toolCall.timestamp,
    toolCall.tool_name,
    toolCall.input_summary,
    toolCall.success,
    toolCall.duration_ms
  );
  debugLog("Inserted tool call:", toolCall.tool_name);
  return Number(result.lastInsertRowid);
}

export function updateToolCallSuccess(sessionId: string, toolName: string, _toolUseId: string, success: boolean, durationMs: number | null, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  // Update the most recent tool call matching session and tool name
  // Note: _toolUseId is available but tool_calls table doesn't store it, so we match by recency
  const stmt = db.prepare(`
    UPDATE tool_calls
    SET success = ?, duration_ms = ?
    WHERE id = (
      SELECT id FROM tool_calls
      WHERE session_id = ? AND tool_name = ?
      ORDER BY timestamp DESC
      LIMIT 1
    )
  `);
  stmt.run(success ? 1 : 0, durationMs, sessionId, toolName);
}

// Analytics queries
export function getToolUsageStats(sessionId?: string, dbPath?: string | null): Array<{ tool_name: string; count: number; success_rate: number }> {
  const db = getDatabase(dbPath);
  let query = `
    SELECT
      tool_name,
      COUNT(*) as count,
      ROUND(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0 END), 2) as success_rate
    FROM tool_calls
  `;
  if (sessionId) {
    query += " WHERE session_id = ?";
  }
  query += " GROUP BY tool_name ORDER BY count DESC";

  const stmt = db.prepare(query);
  type ToolStats = { tool_name: string; count: number; success_rate: number };
  return (sessionId ? stmt.all(sessionId) : stmt.all()) as ToolStats[];
}

export function getRecentSessions(limit: number = 10, dbPath?: string | null): SessionRecord[] {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    SELECT * FROM sessions
    ORDER BY started_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as SessionRecord[];
}

// Event operations
export interface EventRecord {
  id?: number;
  session_id: string;
  timestamp: string;
  event_type: "notification" | "permission_request" | "pre_compact" | "subagent_stop";
  subtype: string | null;
  tool_name: string | null;
  message: string | null;
  metadata: string | null;
}

export function insertEvent(event: EventRecord, dbPath?: string | null): number {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    INSERT INTO events (session_id, timestamp, event_type, subtype, tool_name, message, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    event.session_id,
    event.timestamp,
    event.event_type,
    event.subtype,
    event.tool_name,
    event.message,
    event.metadata
  );
  debugLog("Inserted event:", event.event_type, event.subtype || "");
  return Number(result.lastInsertRowid);
}

// Transcript backup operations
export interface TranscriptBackupRecord {
  id?: number;
  session_id: string;
  timestamp: string;
  trigger: string;
  transcript_path: string;
  backup_path: string | null;
}

export function insertTranscriptBackup(backup: TranscriptBackupRecord, dbPath?: string | null): number {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    INSERT INTO transcript_backups (session_id, timestamp, trigger, transcript_path, backup_path)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    backup.session_id,
    backup.timestamp,
    backup.trigger,
    backup.transcript_path,
    backup.backup_path
  );
  debugLog("Inserted transcript backup for session:", backup.session_id);
  return Number(result.lastInsertRowid);
}

export function getSessionEvents(sessionId: string, dbPath?: string | null): EventRecord[] {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    SELECT * FROM events
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(sessionId) as EventRecord[];
}

// Check if we have any previous sessions for a project (to determine if it's "new")
export function hasProjectSessions(projectPath: string, dbPath?: string | null): boolean {
  const db = getDatabase(dbPath);
  const stmt = db.prepare("SELECT 1 FROM sessions WHERE project_path = ? LIMIT 1");
  return stmt.get(projectPath) !== null;
}
