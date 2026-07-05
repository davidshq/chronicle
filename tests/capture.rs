//! Capture engine tests (spec: lossless-capture).

mod common;
use chronicle::capture::Engine;
use chronicle::config::Layers;
use common::{all_layers, line, test_config};
use std::fs;
use std::io::Write;

fn raw_only() -> Layers {
    Layers { raw: true, markdown: false, sqlite: false }
}

/// Verbatim capture + restart-safe resume: a new Engine (simulating a daemon
/// restart) resumes from the persisted offset and re-copies nothing.
#[test]
fn verbatim_and_restart_resume() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s1.jsonl");

    let l1 = line("s1", "/proj", "user", "hello");
    let l2 = line("s1", "/proj", "assistant", "hi there");
    fs::write(&session, format!("{l1}\n{l2}\n")).unwrap();

    let cfg = test_config(store.clone(), watch.clone(), raw_only());
    {
        let mut engine = Engine::new(cfg.clone()).unwrap();
        let n = engine.sync_file(&session).unwrap();
        assert_eq!(n, 2, "both complete lines captured");
    }

    let raw_copy = store.join("raw").join("proj").join("s1.jsonl");
    assert_eq!(
        fs::read_to_string(&raw_copy).unwrap(),
        format!("{l1}\n{l2}\n"),
        "raw archive is a byte-for-byte copy"
    );

    // Append a third line, restart the engine, and resume.
    let l3 = line("s1", "/proj", "user", "more");
    {
        let mut f = fs::OpenOptions::new().append(true).open(&session).unwrap();
        writeln!(f, "{l3}").unwrap();
    }
    {
        let mut engine = Engine::new(cfg).unwrap(); // fresh instance = restart
        let n = engine.sync_file(&session).unwrap();
        assert_eq!(n, 1, "only the newly appended line is captured on resume");
    }
    assert_eq!(
        fs::read_to_string(&raw_copy).unwrap(),
        format!("{l1}\n{l2}\n{l3}\n"),
        "no duplication; archive holds all three lines"
    );
}

/// A trailing line without a newline is buffered, not persisted, until complete.
#[test]
fn partial_line_is_buffered() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    fs::create_dir_all(&watch).unwrap();
    let session = watch.join("s2.jsonl");

    let l1 = line("s2", "/p", "user", "complete");
    fs::write(&session, format!("{l1}\n{{\"partial\":true")).unwrap(); // no trailing newline

    let cfg = test_config(store.clone(), watch.clone(), raw_only());
    let mut engine = Engine::new(cfg).unwrap();
    let n = engine.sync_file(&session).unwrap();
    assert_eq!(n, 1, "only the complete line is captured");

    let raw_copy = store.join("raw").join("s2.jsonl");
    assert_eq!(fs::read_to_string(&raw_copy).unwrap(), format!("{l1}\n"));

    // Complete the partial line; next sync captures exactly it.
    let l2 = line("s2", "/p", "assistant", "now-complete");
    fs::write(&session, format!("{l1}\n{l2}\n")).unwrap();
    let n2 = engine.sync_file(&session).unwrap();
    assert_eq!(n2, 1, "the completed line is captured, not re-capturing l1");
    assert_eq!(fs::read_to_string(&raw_copy).unwrap(), format!("{l1}\n{l2}\n"));
}

/// scan_all discovers and captures every *.jsonl under the watch dir(s),
/// independent of any hook firing.
#[test]
fn scan_all_captures_new_files() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    fs::create_dir_all(watch.join("a")).unwrap();
    fs::create_dir_all(watch.join("b")).unwrap();
    fs::write(watch.join("a/s.jsonl"), format!("{}\n", line("sa", "/a", "user", "x"))).unwrap();
    fs::write(watch.join("b/s.jsonl"), format!("{}\n", line("sb", "/b", "user", "y"))).unwrap();

    let cfg = test_config(store.clone(), watch, raw_only());
    let mut engine = Engine::new(cfg).unwrap();
    let n = engine.scan_all().unwrap();
    assert_eq!(n, 2, "both session files captured");
    assert!(store.join("raw/a/s.jsonl").exists());
    assert!(store.join("raw/b/s.jsonl").exists());
}

/// A derived-layer failure must never poison the raw archive. Regression for the
/// bug where an error out of `feed_derived` propagated before the offset was
/// persisted, leaving `sync_file` to re-drive — and duplicate — the same bytes
/// into the append-only raw archive on the next tick.
#[test]
fn derived_failure_does_not_duplicate_raw() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s1.jsonl");

    let l1 = line("s1", "/proj", "user", "hello");
    let l2 = line("s1", "/proj", "assistant", "hi");
    fs::write(&session, format!("{l1}\n{l2}\n")).unwrap();

    let cfg = test_config(store.clone(), watch.clone(), all_layers());
    let mut engine = Engine::new(cfg).unwrap();

    // Sabotage the markdown layer: occupy its per-project folder with a regular
    // file so every `ensure_file` -> create_dir_all fails, forcing feed_derived
    // to error on each line. This exercises the raw-vs-derived isolation.
    let md_project = store.join("markdown").join("proj");
    fs::write(&md_project, b"not a directory").unwrap();

    // Despite the derived failure, capture succeeds and raw gets both lines once.
    let n = engine.sync_file(&session).unwrap();
    assert_eq!(n, 2);
    let raw_copy = store.join("raw").join("proj").join("s1.jsonl");
    assert_eq!(fs::read_to_string(&raw_copy).unwrap(), format!("{l1}\n{l2}\n"));

    // Append a third line and sync again. The offset advanced past the first two
    // even though the derived layer failed, so raw must NOT re-copy them.
    let l3 = line("s1", "/proj", "user", "more");
    {
        let mut f = fs::OpenOptions::new().append(true).open(&session).unwrap();
        writeln!(f, "{l3}").unwrap();
    }
    let n = engine.sync_file(&session).unwrap();
    assert_eq!(n, 1, "only the new line is processed; no re-drive of raw");
    assert_eq!(
        fs::read_to_string(&raw_copy).unwrap(),
        format!("{l1}\n{l2}\n{l3}\n"),
        "raw stays a single clean copy despite the derived-layer failure"
    );
}
