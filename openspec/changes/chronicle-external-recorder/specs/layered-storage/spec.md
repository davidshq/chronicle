## ADDED Requirements

### Requirement: Raw JSONL archive as ground truth
The daemon SHALL maintain a verbatim, append-only raw JSONL archive that is preserved independently of Claude Code's own retention, and SHALL treat this archive as the authoritative source for all derived layers.

#### Scenario: Claude Code deletes an old session file
- **WHEN** Claude Code auto-deletes a session transcript under its retention policy
- **THEN** the copy in Chronicle's raw archive remains intact

#### Scenario: Raw archive is never rewritten
- **WHEN** new lines are captured for an existing session
- **THEN** they are appended to the raw archive and previously written lines are never modified or removed

### Requirement: Independently configurable output layers
The system SHALL provide raw JSONL, markdown mirror, and SQLite/FTS index as output layers that can each be enabled or disabled independently.

#### Scenario: Raw only
- **WHEN** only the raw layer is enabled
- **THEN** the daemon writes the raw archive and produces neither markdown nor SQLite output

#### Scenario: All layers enabled
- **WHEN** all layers are enabled
- **THEN** the daemon writes the raw archive and derives both the markdown mirror and the SQLite/FTS index from it

### Requirement: Derived layers reference the raw layer
Markdown and SQLite layers SHALL be renderings/indexes over the raw archive and SHALL NOT be the sole store of any captured content.

#### Scenario: Rebuild derived layers from raw
- **WHEN** the markdown or SQLite layer is deleted and regeneration is requested
- **THEN** the system can reconstruct it from the raw archive without data loss

### Requirement: Debounced indexing of expensive layers
The SQLite/FTS layer SHALL be updated on a debounced cadence rather than on every captured line.

#### Scenario: Rapid successive writes
- **WHEN** many transcript lines are captured in quick succession
- **THEN** the SQLite/FTS index is updated in batches on a debounced schedule, not once per line
