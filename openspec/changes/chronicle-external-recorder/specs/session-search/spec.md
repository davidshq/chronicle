## ADDED Requirements

### Requirement: Full-text search over captured sessions
The `chronicle` plugin SHALL let users search past captured sessions by keyword against the SQLite/FTS index.

#### Scenario: Keyword search returns matches
- **WHEN** a user searches for a keyword that appears in past sessions
- **THEN** the plugin returns matching sessions with enough context to identify and open them

#### Scenario: No matches
- **WHEN** a user searches for a keyword that appears in no session
- **THEN** the plugin reports that there are no matches

### Requirement: Today's sessions listing
The plugin SHALL list the sessions captured on the current local day.

#### Scenario: List today's sessions
- **WHEN** a user requests today's sessions
- **THEN** the plugin lists sessions started on the current local calendar day

### Requirement: Status overview
The plugin SHALL provide a status command reporting logging/capture status and recent sessions.

#### Scenario: Show status
- **WHEN** a user requests status
- **THEN** the plugin reports current capture health (via the watchdog) and a list of recent sessions
