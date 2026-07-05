//! Markdown mirror — a human-readable rendering derived from the raw archive.
//!
//! Tool-input formatting is ported from the old `src/markdown.ts`. Unlike the
//! raw layer, markdown MAY truncate large tool bodies (bounded by
//! `max_tool_output_length`) since the untruncated original always lives in raw.

use crate::jsonl::{Entry, ParsedLine};
use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct MarkdownMirror {
    root: PathBuf,
    max_len: usize,
    /// session_id -> markdown file path (created lazily on first entry).
    paths: HashMap<String, PathBuf>,
}

impl MarkdownMirror {
    pub fn new(root: PathBuf, max_len: usize) -> Self {
        MarkdownMirror { root, max_len, paths: HashMap::new() }
    }

    /// Append a parsed line's entries to its session's markdown file.
    pub fn write_line(&mut self, session_id: &str, project_path: &str, line: &ParsedLine) -> Result<PathBuf> {
        let path = self.ensure_file(session_id, project_path, line)?;
        let mut body = String::new();
        let time = line.timestamp.as_deref().unwrap_or("");
        for entry in &line.entries {
            match entry {
                Entry::Text { role, text } => {
                    let heading = match role.as_str() {
                        "user" => "User",
                        "assistant" => "Assistant",
                        _ => "System",
                    };
                    body.push_str(&format!("## {} ({})\n\n{}\n\n---\n\n", heading, time, text));
                }
                Entry::ToolUse { name, input, .. } => {
                    body.push_str(&format!(
                        "### Tool: {} ({})\n\n{}\n\n",
                        name,
                        time,
                        self.format_tool_input(name, input)
                    ));
                }
                Entry::ToolResult { content, .. } => {
                    let out = self.truncate(content);
                    body.push_str(&format!(
                        "**Result**\n\n<details>\n<summary>Output</summary>\n\n```\n{}\n```\n</details>\n\n",
                        out
                    ));
                }
            }
        }
        if !body.is_empty() {
            append(&path, &body)?;
        }
        Ok(path)
    }

    fn ensure_file(&mut self, session_id: &str, project_path: &str, line: &ParsedLine) -> Result<PathBuf> {
        if let Some(p) = self.paths.get(session_id) {
            return Ok(p.clone());
        }
        // Group by the session's *local* calendar day, not the raw UTC date
        // slice, so sessions near midnight file under the right folder. Fall
        // back to the raw prefix if the timestamp can't be parsed.
        let date = match line.timestamp.as_deref() {
            Some(t) => crate::time::local_date(t)
                .unwrap_or_else(|| t.get(0..10).unwrap_or("unknown-date").to_string()),
            None => "unknown-date".to_string(),
        };
        let project = sanitize(last_component(project_path));
        // Use the full session id, not an 8-char prefix: two sessions sharing a
        // hex prefix in the same project would otherwise collide into one file.
        let session = sanitize(session_id);
        let dir = self.root.join(&date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}_{}.md", session, project));
        if !path.exists() {
            let header = format!(
                "# Session: {}\n\n**Project**: `{}`\n**Started**: {}\n\n---\n\n",
                session_id,
                project_path,
                line.timestamp.as_deref().unwrap_or("")
            );
            std::fs::write(&path, header)?;
        }
        self.paths.insert(session_id.to_string(), path.clone());
        Ok(path)
    }

    fn truncate(&self, s: &str) -> String {
        if s.chars().count() <= self.max_len {
            s.to_string()
        } else {
            let truncated: String = s.chars().take(self.max_len).collect();
            format!("{}\n\n... (truncated — full content in raw archive)", truncated)
        }
    }

    /// Ported from `formatToolInput` in the old markdown.ts.
    fn format_tool_input(&self, tool: &str, input: &Value) -> String {
        let get = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");
        match tool {
            "Bash" => {
                let mut s = format!("**Command**: `{}`", get("command"));
                let desc = get("description");
                if !desc.is_empty() {
                    s.push_str(&format!("\n**Description**: {}", desc));
                }
                s
            }
            "Write" => format!(
                "**File**: `{}`\n\n```\n{}\n```",
                get("file_path"),
                self.truncate(get("content"))
            ),
            "Edit" => format!(
                "**File**: `{}`\n\n**Replace**:\n```\n{}\n```\n\n**With**:\n```\n{}\n```",
                get("file_path"),
                self.truncate(get("old_string")),
                self.truncate(get("new_string"))
            ),
            "Read" => format!("**File**: `{}`", get("file_path")),
            "Glob" => format!("**Pattern**: `{}`", get("pattern")),
            "Grep" => format!("**Pattern**: `{}`", get("pattern")),
            "WebFetch" => format!("**URL**: {}", get("url")),
            "WebSearch" => format!("**Query**: {}", get("query")),
            _ => {
                let json = serde_json::to_string_pretty(input).unwrap_or_default();
                format!("```json\n{}\n```", self.truncate(&json))
            }
        }
    }
}

fn append(path: &Path, text: &str) -> Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(text.as_bytes())?;
    Ok(())
}

fn last_component(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(p)
}

fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let out: String = trimmed.chars().take(50).collect();
    if out.is_empty() { "unknown-project".to_string() } else { out }
}
