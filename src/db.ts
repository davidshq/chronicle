import { Database } from "bun:sqlite";
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

export function getDatabase(customDbPath?: string | null): Database {
  const config = getConfig();
  const dbPath = customDbPath || config.dbPath;

  // Check cache first
  const cached = databases.get(dbPath);
  if (cached) {
    return cached;
  }

  debugLog("Opening database at:", dbPath);

  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent access
  if (config.enableWAL) {
    db.exec("PRAGMA journal_mode = WAL");
  }

  // Create tables
  db.exec(SCHEMA);

  // Migration: add markdown_path column if it doesn't exist (for existing databases)
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN markdown_path TEXT");
  } catch (e) {
    // Column already exists, ignore
  }

  // Cache the database
  databases.set(dbPath, db);

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

export function messageExists(sessionId: string, timestamp: string, role: string, contentPrefix: string, dbPath?: string | null): boolean {
  const db = getDatabase(dbPath);
  const stmt = db.prepare(`
    SELECT 1 FROM messages
    WHERE session_id = ? AND timestamp = ? AND role = ? AND content LIKE ?
    LIMIT 1
  `);
  const result = stmt.get(sessionId, timestamp, role, contentPrefix + "%");
  return result !== null;
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

export function updateToolCallSuccess(sessionId: string, toolName: string, toolUseId: string, success: boolean, dbPath?: string | null): void {
  const db = getDatabase(dbPath);
  // Update the most recent tool call matching these criteria
  const stmt = db.prepare(`
    UPDATE tool_calls
    SET success = ?
    WHERE id = (
      SELECT id FROM tool_calls
      WHERE session_id = ? AND tool_name = ?
      ORDER BY timestamp DESC
      LIMIT 1
    )
  `);
  stmt.run(success ? 1 : 0, sessionId, toolName);
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
  return sessionId ? stmt.all(sessionId) as any : stmt.all() as any;
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
