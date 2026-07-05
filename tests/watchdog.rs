//! Watchdog + search tests (specs: recorder-watchdog, session-search).

mod common;
use chronicle::commands::watchdog::{evaluate_health, Health};
use chronicle::store::{Heartbeat, Store};
use common::{all_layers, test_config};

#[test]
fn health_down_when_no_heartbeat() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = test_config(tmp.path().join("store"), tmp.path().join("p"), all_layers());
    Store::new(cfg.store_dir.clone()).ensure_dirs().unwrap();
    match evaluate_health(&cfg) {
        Health::Down { .. } => {}
        _ => panic!("expected Down when no heartbeat exists"),
    }
}

#[test]
fn health_healthy_with_fresh_heartbeat() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = test_config(tmp.path().join("store"), tmp.path().join("p"), all_layers());
    let store = Store::new(cfg.store_dir.clone());
    store.ensure_dirs().unwrap();
    let hb = Heartbeat {
        pid: std::process::id(), // this live test process
        started_at: chronicle::commands::now_rfc3339(),
        last_sync: chronicle::commands::now_rfc3339(),
        last_alive: chronicle::commands::now_rfc3339(),
    };
    Heartbeat::write(&store, &hb).unwrap();
    match evaluate_health(&cfg) {
        Health::Healthy { .. } => {}
        other => panic!("expected Healthy, got {}", label(&other)),
    }
}

/// The idle-but-live case: no capture for ages (ancient `last_sync`) but the
/// liveness tick is fresh. The daemon is healthy, not stale.
#[test]
fn health_healthy_when_idle_but_alive() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = test_config(tmp.path().join("store"), tmp.path().join("p"), all_layers());
    cfg.staleness_secs = 60;
    let store = Store::new(cfg.store_dir.clone());
    store.ensure_dirs().unwrap();
    let hb = Heartbeat {
        pid: std::process::id(),
        started_at: chronicle::commands::now_rfc3339(),
        last_sync: "2000-01-01T00:00:00+00:00".to_string(), // no capture for ages
        last_alive: chronicle::commands::now_rfc3339(),     // but liveness is fresh
    };
    Heartbeat::write(&store, &hb).unwrap();
    match evaluate_health(&cfg) {
        Health::Healthy { .. } => {}
        other => panic!("expected Healthy (idle but alive), got {}", label(&other)),
    }
}

#[test]
fn health_stale_with_old_heartbeat() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = test_config(tmp.path().join("store"), tmp.path().join("p"), all_layers());
    cfg.staleness_secs = 60;
    let store = Store::new(cfg.store_dir.clone());
    store.ensure_dirs().unwrap();
    let hb = Heartbeat {
        pid: std::process::id(),
        started_at: chronicle::commands::now_rfc3339(),
        last_sync: "2000-01-01T00:00:00+00:00".to_string(), // ancient
        last_alive: "2000-01-01T00:00:00+00:00".to_string(), // liveness tick also wedged
    };
    Heartbeat::write(&store, &hb).unwrap();
    match evaluate_health(&cfg) {
        Health::Stale { .. } => {}
        other => panic!("expected Stale, got {}", label(&other)),
    }
}

fn label(h: &Health) -> &'static str {
    match h {
        Health::Healthy { .. } => "Healthy",
        Health::Stale { .. } => "Stale",
        Health::Down { .. } => "Down",
    }
}
