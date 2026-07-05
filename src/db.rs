//! SQLite index (derived layer) with FTS5 full-text search.
//!
//! Schema shape ported from the old `src/db.ts` (sessions / messages /
//! tool_calls / events), plus an FTS5 virtual table over message content so
//! `chronicle search` can do full-text queries. This is a *derived* layer:
//! it can be dropped and rebuilt from the raw archive at any time.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Index {
    pub conn: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    project_path  TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    status        TEXT DEFAULT 'active',
    message_count INTEGER DEFAULT 0,
    markdown_path TEXT,
    raw_path      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    uuid        TEXT,
    timestamp   TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    tool_name   TEXT,
    tool_input  TEXT,
    tool_output TEXT,
    UNIQUE(session_id, uuid)
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    message_id    INTEGER,
    timestamp     TEXT NOT NULL,
    tool_name     TEXT NOT NULL,
    input_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(started_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, tool_name, tool_input, tool_output,
    content='messages', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, tool_name, tool_input, tool_output)
    VALUES (new.id, new.content, new.tool_name, new.tool_input, new.tool_output);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_input, tool_output)
    VALUES ('delete', old.id, old.content, old.tool_name, old.tool_input, old.tool_output);
END;
"#;

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub project_path: String,
    pub started_at: String,
    pub message_count: i64,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub session_id: String,
    pub project_path: String,
    pub timestamp: String,
    pub role: String,
    pub snippet: String,
}

impl Index {
    /// Open (creating if needed) and initialize the index database.
    pub fn open(path: &Path) -> Result<Index> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)
            .with_context(|| format!("opening index db {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)
            .context("initializing index schema")?;
        Ok(Index { conn })
    }

    /// Open an in-memory index (used by tests).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Index> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Index { conn })
    }

    pub fn upsert_session(
        &self,
        id: &str,
        project_path: &str,
        started_at: &str,
        raw_path: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, project_path, started_at, raw_path)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                project_path = excluded.project_path,
                raw_path = COALESCE(excluded.raw_path, sessions.raw_path)",
            params![id, project_path, started_at, raw_path],
        )?;
        Ok(())
    }

    pub fn set_markdown_path(&self, session_id: &str, path: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET markdown_path = ?2 WHERE id = ?1",
            params![session_id, path],
        )?;
        Ok(())
    }

    /// Insert a message. Idempotent on (session_id, uuid) so re-indexing the
    /// raw archive does not duplicate rows. Returns true if a row was inserted.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_message(
        &self,
        session_id: &str,
        uuid: Option<&str>,
        timestamp: &str,
        role: &str,
        content: &str,
        tool_name: Option<&str>,
        tool_input: Option<&str>,
        tool_output: Option<&str>,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO messages
                (session_id, uuid, timestamp, role, content, tool_name, tool_input, tool_output)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![session_id, uuid, timestamp, role, content, tool_name, tool_input, tool_output],
        )?;
        if changed > 0 {
            self.conn.execute(
                "UPDATE sessions SET message_count = message_count + 1 WHERE id = ?1",
                params![session_id],
            )?;
        }
        Ok(changed > 0)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.session_id, s.project_path, m.timestamp, m.role,
                    snippet(messages_fts, 0, '[', ']', ' … ', 12)
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE messages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![query, limit as i64], |r| {
                Ok(SearchHit {
                    session_id: r.get(0)?,
                    project_path: r.get(1)?,
                    timestamp: r.get(2)?,
                    role: r.get(3)?,
                    snippet: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn recent_sessions(&self, limit: usize) -> Result<Vec<SessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_path, started_at, message_count
             FROM sessions ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], map_session)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Sessions whose UTC `started_at` falls in the half-open range
    /// `[start, end)` (both RFC3339 UTC strings). A local calendar day maps to
    /// such a UTC range — see `crate::time::today_local_utc_bounds`.
    pub fn sessions_in_range(&self, start: &str, end: &str) -> Result<Vec<SessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_path, started_at, message_count
             FROM sessions WHERE started_at >= ?1 AND started_at < ?2
             ORDER BY started_at ASC",
        )?;
        let rows = stmt
            .query_map(params![start, end], map_session)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    #[allow(dead_code)]
    pub fn session_count(&self) -> Result<i64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(n)
    }
}

fn map_session(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get(0)?,
        project_path: r.get(1)?,
        started_at: r.get(2)?,
        message_count: r.get(3)?,
    })
}
