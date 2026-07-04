## ADDED Requirements

### Requirement: Daemon liveness and store-freshness monitoring
The `chronicle` plugin SHALL check whether the `chronicled` daemon is running and whether the store is being updated, using signals such as process liveness, a daemon heartbeat, and store modification/last-sync timestamps.

#### Scenario: Daemon not running
- **WHEN** the plugin runs its health check and the daemon process is not alive
- **THEN** it surfaces an in-session warning that the recorder is not running, with guidance to start it

#### Scenario: Store gone stale
- **WHEN** the daemon appears alive but the store has not advanced within the configured staleness threshold
- **THEN** the plugin warns that the recorder has stopped updating (e.g. "recorder hasn't synced in 2h / DB not updating")

### Requirement: Monitoring failures are non-destructive
The watchdog SHALL be implemented so that a failure of the plugin's monitoring path does not affect capture.

#### Scenario: Monitoring hook silently fails
- **WHEN** the plugin's monitoring hook does not fire
- **THEN** capture by the daemon is unaffected and the only consequence is a missed warning

### Requirement: Healthy state confirmation
The plugin SHALL be able to report a healthy state when the daemon is running and the store is fresh.

#### Scenario: Everything healthy
- **WHEN** the daemon is alive and the store has updated within the staleness threshold
- **THEN** a status check reports capture as healthy
