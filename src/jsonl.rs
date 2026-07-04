//! Lenient parsing of Claude Code transcript JSONL lines.
//!
//! Only the *derived* layers (markdown, index) parse transcript content; the
//! raw archive copies bytes verbatim and never depends on this. Because the
//! transcript format is internal to Claude Code and drifts between versions,
//! this parser is deliberately permissive: unknown shapes yield no entries
//! rather than errors, so a format change degrades derived layers gracefully
//! without ever risking the lossless raw copy.

use serde_json::Value;

/// One meaningful unit extracted from a transcript line.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Text { role: String, text: String },
    ToolUse { name: String, input: Value },
    ToolResult { content: String },
}

#[derive(Debug, Clone, Default)]
pub struct ParsedLine {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub timestamp: Option<String>,
    pub uuid: Option<String>,
    pub entries: Vec<Entry>,
}

impl ParsedLine {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Parse a single JSONL line. Returns `None` for blank lines or non-JSON.
pub fn parse_line(line: &str) -> Option<ParsedLine> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;

    let mut out = ParsedLine {
        session_id: str_field(&v, "sessionId").or_else(|| str_field(&v, "session_id")),
        cwd: str_field(&v, "cwd"),
        timestamp: str_field(&v, "timestamp"),
        uuid: str_field(&v, "uuid"),
        entries: Vec::new(),
    };

    // Determine role: prefer message.role, fall back to top-level type.
    let msg = v.get("message");
    let role = msg
        .and_then(|m| str_field(m, "role"))
        .or_else(|| str_field(&v, "type"))
        .unwrap_or_else(|| "system".to_string());
    let role = normalize_role(&role);

    let content = msg.and_then(|m| m.get("content"));
    match content {
        Some(Value::String(s)) => {
            if !s.trim().is_empty() {
                out.entries.push(Entry::Text { role, text: s.clone() });
            }
        }
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if let Some(entry) = parse_block(block, &role) {
                    out.entries.push(entry);
                }
            }
        }
        _ => {}
    }

    Some(out)
}

fn parse_block(block: &Value, role: &str) -> Option<Entry> {
    let ty = str_field(block, "type")?;
    match ty.as_str() {
        "text" => {
            let text = str_field(block, "text")?;
            if text.trim().is_empty() {
                None
            } else {
                Some(Entry::Text { role: role.to_string(), text })
            }
        }
        "tool_use" => {
            let name = str_field(block, "name").unwrap_or_default();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            Some(Entry::ToolUse { name, input })
        }
        "tool_result" => {
            let content = match block.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            Some(Entry::ToolResult { content })
        }
        _ => None,
    }
}

fn normalize_role(role: &str) -> String {
    match role {
        "human" | "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    }
    .to_string()
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_text() {
        let line = r#"{"type":"user","sessionId":"abc","timestamp":"t","message":{"role":"user","content":"hello"}}"#;
        let p = parse_line(line).unwrap();
        assert_eq!(p.session_id.as_deref(), Some("abc"));
        assert_eq!(p.entries, vec![Entry::Text { role: "user".into(), text: "hello".into() }]);
    }

    #[test]
    fn parses_tool_use_with_full_input() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/x","content":"BIG"}}]}}"#;
        let p = parse_line(line).unwrap();
        match &p.entries[0] {
            Entry::ToolUse { name, input } => {
                assert_eq!(name, "Write");
                assert_eq!(input["content"], "BIG");
            }
            _ => panic!("expected tool_use"),
        }
    }

    #[test]
    fn blank_and_garbage_are_none() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("not json").is_none());
    }

    #[test]
    fn unknown_shape_yields_no_entries() {
        let line = r#"{"type":"compact_boundary","compactMetadata":{"preTokens":1000}}"#;
        let p = parse_line(line).unwrap();
        assert!(p.is_empty());
    }
}
