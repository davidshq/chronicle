# tool-exclusion Specification

## Purpose

Define how tools named in the `exclude_tools` config are suppressed from Chronicle's derived layers (the markdown mirror and the SQLite/FTS index) while remaining byte-for-byte intact in the raw archive.

## Requirements

### Requirement: Excluded tools are removed from derived layers

The `exclude_tools` config list names tools whose activity SHALL be removed from
the derived layers (the markdown mirror and the SQLite/FTS index). Both the
tool's invocation (`tool_use`) and its output (`tool_result`) SHALL be
suppressed, so that neither the command nor its result appears in any derived
layer. The raw archive is ground truth and SHALL NOT be filtered — every
excluded entry remains byte-for-byte in raw.

#### Scenario: Excluded tool call is dropped from derived layers

- **WHEN** a transcript line contains a `tool_use` block whose tool name is in
  `exclude_tools`
- **THEN** that `tool_use` does not appear in the markdown mirror or the index
- **AND** the same line is still written verbatim to the raw archive

#### Scenario: Excluded tool result is dropped from derived layers

- **WHEN** a `tool_result` block arrives whose `tool_use_id` matches a
  previously seen `tool_use` for an excluded tool
- **THEN** that `tool_result` does not appear in the markdown mirror or the index
- **AND** the raw line carrying the `tool_result` is still written verbatim to
  the raw archive

#### Scenario: Non-excluded tool result is retained

- **WHEN** a `tool_result` block arrives whose originating tool is not in
  `exclude_tools`
- **THEN** that `tool_result` appears in the derived layers as normal

#### Scenario: Rebuild re-applies the filter

- **WHEN** `chronicle rebuild` replays the raw archive in order with an
  `exclude_tools` entry configured
- **THEN** the regenerated derived layers omit both the excluded `tool_use` and
  its associated `tool_result`

### Requirement: Cross-line association is best-effort across daemon restarts

The system SHALL suppress an excluded tool's `tool_result` whenever the
originating `tool_use` was observed by the same running daemon. The association
between a `tool_use` and its `tool_result` is carried in daemon memory because
the two blocks arrive on separate transcript lines. If the daemon restarts
between capturing an excluded `tool_use` line and its `tool_result` line, the
system MAY let that single `tool_result` through to the derived layers; this is
an accepted limitation that SHALL NOT affect the raw archive and SHALL be
correctable by `chronicle rebuild`.

#### Scenario: Result seen after its call within one daemon lifetime

- **WHEN** a daemon captures an excluded `tool_use` and later captures the
  matching `tool_result` without restarting
- **THEN** both are suppressed from the derived layers

#### Scenario: Daemon restart between call and result

- **WHEN** the daemon restarts after capturing an excluded `tool_use` but before
  capturing its `tool_result`
- **THEN** the `tool_result` may appear in the derived layers until a `rebuild`
- **AND** the raw archive still contains both lines unmodified
