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

/// Cap on the lazily-built session→path cache. A single `rebuild` streams every
/// session in the archive through one mirror; without a bound the map would grow
/// one entry per session for the whole run. Clearing when full is safe — a later
/// miss just recomputes the path and re-checks existence (which no-ops the header
/// write on an already-created file).
const MAX_CACHED_PATHS: usize = 4096;

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
        // Sanitize the *full* project path for the folder, not just its last
        // component, so two repos sharing a basename (e.g. ~/work/api and
        // ~/personal/api) get distinct folders instead of merging — mirroring
        // how the raw layer keeps them apart by their full encoded path.
        let project = sanitize(project_path);
        // The filename keeps its short basename suffix for at-a-glance context
        // when a file is viewed outside its folder (search results, `find`, …).
        let project_name = sanitize(last_component(project_path));
        // Use the full session id, not an 8-char prefix: two sessions sharing a
        // hex prefix in the same project would otherwise collide into one file.
        let session = sanitize(session_id);
        // Group by repo first, then day: markdown/<project>/<date>/<session>_<name>.md.
        let dir = self.root.join(&project).join(&date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}_{}.md", session, project_name));
        if !path.exists() {
            let header = format!(
                "# Session: {}\n\n**Project**: `{}`\n**Started**: {}\n\n---\n\n",
                session_id,
                project_path,
                line.timestamp.as_deref().unwrap_or("")
            );
            std::fs::write(&path, header)?;
        }
        if self.paths.len() >= MAX_CACHED_PATHS {
            self.paths.clear();
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

/// Longest path component we emit. Bounded well under the 255-byte per-component
/// limit common to ext4/APFS/NTFS, with headroom for the disambiguating hash.
const MAX_COMPONENT: usize = 120;

/// Map an arbitrary string (project path, session id) to a safe path component.
///
/// Non-`[A-Za-z0-9_-]` characters become `-`. When the result would exceed
/// `MAX_COMPONENT`, we keep a readable prefix and append a stable hash of the
/// full sanitized value — so two long paths that share a prefix (e.g.
/// deeply-nested monorepo siblings) can never truncate into the same folder.
/// Truncation used to just drop the tail, silently merging such paths.
fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        return "unknown-project".to_string();
    }
    if trimmed.chars().count() <= MAX_COMPONENT {
        return trimmed.to_string();
    }
    // Too long: readable prefix + a collision-resistant suffix keyed off the
    // full *sanitized* value (the same canonical form the prefix comes from),
    // so distinct paths stay distinct while incidental byte differences that
    // sanitize away (e.g. a trailing slash) still map to one stable folder.
    let prefix: String = trimmed.chars().take(MAX_COMPONENT).collect();
    format!("{}-{:016x}", prefix.trim_end_matches('-'), fnv1a(trimmed))
}

/// FNV-1a 64-bit. A tiny, dependency-free, version-stable hash — unlike
/// `std`'s `DefaultHasher`, whose output isn't guaranteed across toolchains, so
/// folder names stay put across Rust upgrades.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_inputs_pass_through_unchanged() {
        assert_eq!(sanitize("/home/dave/repos/api"), "home-dave-repos-api");
        // A session UUID is well under the cap and must be emitted verbatim.
        assert_eq!(
            sanitize("2eadfa15-bda9-47a5-b18d-3ca22027a9c9"),
            "2eadfa15-bda9-47a5-b18d-3ca22027a9c9"
        );
    }

    #[test]
    fn empty_after_sanitizing_falls_back() {
        assert_eq!(sanitize("/"), "unknown-project");
        assert_eq!(sanitize(""), "unknown-project");
    }

    #[test]
    fn long_paths_sharing_a_prefix_do_not_collide() {
        // Two distinct repos whose difference lies *past* the truncation point.
        let base = "/home/dave/".to_string() + &"nested/".repeat(30);
        let a = sanitize(&(base.clone() + "service-alpha"));
        let b = sanitize(&(base + "service-beta"));
        assert_ne!(a, b, "prefix-sharing long paths must stay distinct");
        // Each stays within the per-component filesystem limit.
        assert!(a.len() <= MAX_COMPONENT + 17 && b.len() <= MAX_COMPONENT + 17);
    }

    #[test]
    fn hash_is_stable() {
        // Guards against an accidental constant/algorithm change that would
        // silently relocate every truncated folder on the next rebuild.
        assert_eq!(fnv1a("chronicle"), 0xad20_67bc_d635_bf42);
    }
}
