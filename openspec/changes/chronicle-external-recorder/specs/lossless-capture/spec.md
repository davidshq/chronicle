## ADDED Requirements

### Requirement: Hook-independent capture
The `chronicle daemon` process SHALL capture Claude Code session data by observing on-disk session transcripts, and SHALL NOT depend on Claude Code hook events firing.

#### Scenario: Long session where hooks stop firing
- **WHEN** a Claude Code session runs longer than the interval after which hooks silently stop firing
- **THEN** the daemon continues to capture all new session lines because it observes the transcript files directly

#### Scenario: Session exits via /exit without SessionEnd
- **WHEN** a session ends via `/exit` (which does not reliably fire `SessionEnd`)
- **THEN** the daemon has already captured every line written up to that point

### Requirement: Verbatim lossless capture
The daemon SHALL preserve every captured transcript line byte-for-byte, without truncation, filtering, or summarization of the raw layer.

#### Scenario: Large tool output
- **WHEN** the transcript contains a tool result larger than any prior truncation limit
- **THEN** the raw archive stores the full content with no truncation

#### Scenario: All content types preserved
- **WHEN** the transcript contains user prompts, assistant text, tool_use blocks (including full file contents and edits), tool_result blocks, and thinking blocks
- **THEN** all of them are preserved verbatim in the raw archive

### Requirement: Restart-safe offset tracking
The daemon SHALL track a per-file byte offset and persist it, so that on restart it resumes without re-copying or skipping data.

#### Scenario: Daemon restarts mid-session
- **WHEN** the daemon is stopped and restarted while a session file has grown
- **THEN** on restart it reads only the bytes appended since its last persisted offset, copying each new line exactly once

#### Scenario: Partial line written at read time
- **WHEN** a read observes a transcript file whose last line is not yet terminated by a newline
- **THEN** the daemon buffers the incomplete line and does not persist it until the newline arrives

### Requirement: Live-by-default capture with periodic fallback
The daemon SHALL support a live filesystem-watch trigger as the default and a periodic-poll trigger as a configurable fallback, both driving the same capture engine.

#### Scenario: Live capture at idle
- **WHEN** no session file is being written
- **THEN** the live watcher consumes negligible CPU until a write occurs

#### Scenario: Fallback where watch APIs are unavailable
- **WHEN** filesystem-watch is unavailable or disabled by configuration
- **THEN** the daemon captures via periodic polling at the configured interval with no loss relative to live mode for append-only files

### Requirement: New session file detection
The daemon SHALL detect newly created session transcript files, including continuation files produced at compaction boundaries.

#### Scenario: New session file appears
- **WHEN** Claude Code creates a new session transcript file in a watched directory
- **THEN** the daemon begins capturing it from its first line
