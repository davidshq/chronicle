## ADDED Requirements

### Requirement: Opt-in derived narrative summaries
The system SHALL generate human-readable narrative summaries as an opt-in, LLM-powered layer that is disabled by default and isolated from the free, network-independent core layers.

#### Scenario: Summaries disabled by default
- **WHEN** a user installs Chronicle without enabling summaries
- **THEN** no LLM calls are made and no summary artifacts are produced, while raw/markdown/SQLite capture proceeds normally

#### Scenario: Summaries enabled
- **WHEN** a user enables the narrative layer
- **THEN** the system generates a summary per session (on session boundary or on demand)

### Requirement: Rabbit-hole compression with dead-end retention
A narrative summary SHALL compress exploratory detours while still naming each significant detour and its dead-end outcome.

#### Scenario: Session with an abandoned approach
- **WHEN** a session tried an approach that was abandoned before the final solution
- **THEN** the summary briefly records that the detour occurred and why it was abandoned, rather than omitting it or reproducing it in full

### Requirement: Cross-reference to the raw archive
Every narrative summary SHALL link its statements back to the corresponding line ranges in the raw archive.

#### Scenario: Reader drills into a summarized event
- **WHEN** a reader views a summarized event
- **THEN** they can follow a reference to the exact raw-archive line range where that event occurred

#### Scenario: Summary never replaces source
- **WHEN** a narrative summary is generated
- **THEN** the raw archive for that session remains complete and unmodified
