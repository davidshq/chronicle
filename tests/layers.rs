//! Layered-storage tests (spec: layered-storage).

mod common;
use chronicle::capture::Engine;
use chronicle::config::Layers;
use chronicle::db::Index;
use common::{all_layers, line, test_config};
use std::fs;

fn write_session(watch: &std::path::Path) -> std::path::PathBuf {
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");
    let l1 = line("s1", "/home/me/proj", "user", "implement the parser");
    let l2 = line("s1", "/home/me/proj", "assistant", "done with the widget");
    fs::write(&session, format!("{l1}\n{l2}\n")).unwrap();
    session
}

#[test]
fn raw_only_writes_no_derived_layers() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let session = write_session(&watch);

    let cfg = test_config(store.clone(), watch, Layers { raw: true, markdown: false, sqlite: false });
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    assert!(store.join("raw/proj/s.jsonl").exists(), "raw written");
    assert!(!store.join("index.db").exists(), "no sqlite index");
    // markdown dir may exist (created by ensure_dirs) but must contain no files
    let md_files = walk_count(&store.join("markdown"));
    assert_eq!(md_files, 0, "no markdown produced");
}

#[test]
fn all_layers_populate_index_and_markdown() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let session = write_session(&watch);

    let cfg = test_config(store.clone(), watch, all_layers());
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    // Index populated + searchable.
    let index = Index::open(&store.join("index.db")).unwrap();
    let hits = index.search("parser", 10).unwrap();
    assert_eq!(hits.len(), 1, "FTS finds the user message");
    assert!(walk_count(&store.join("markdown")) >= 1, "markdown mirror produced");
}

/// Derived layers can be deleted and rebuilt entirely from the raw archive.
#[test]
fn rebuild_derived_from_raw() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let session = write_session(&watch);

    let cfg = test_config(store.clone(), watch, all_layers());
    cfg.save().unwrap(); // rebuild loads config from the store
    {
        let mut engine = Engine::new(cfg).unwrap();
        engine.sync_file(&session).unwrap();
    }

    // Nuke derived layers.
    fs::remove_file(store.join("index.db")).ok();
    fs::remove_dir_all(store.join("markdown")).ok();

    // Rebuild purely from raw.
    let n = chronicle::commands::rebuild::rebuild(Some(store.clone())).unwrap();
    assert!(n >= 2, "reprocessed the raw lines");

    let index = Index::open(&store.join("index.db")).unwrap();
    let hits = index.search("widget", 10).unwrap();
    assert_eq!(hits.len(), 1, "index reconstructed from raw is searchable");
}

/// The raw copy survives deletion of the source transcript (retention deletion).
#[test]
fn raw_survives_source_deletion() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let session = write_session(&watch);

    let cfg = test_config(store.clone(), watch, all_layers());
    {
        let mut engine = Engine::new(cfg).unwrap();
        engine.sync_file(&session).unwrap();
    }

    // Claude Code deletes the old session file.
    fs::remove_file(&session).unwrap();

    assert!(store.join("raw/proj/s.jsonl").exists(), "raw copy persists after source deletion");
    let index = Index::open(&store.join("index.db")).unwrap();
    assert_eq!(index.search("parser", 10).unwrap().len(), 1, "still searchable");
}

fn walk_count(dir: &std::path::Path) -> usize {
    let mut n = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += walk_count(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}
