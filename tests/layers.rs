//! Layered-storage tests (spec: layered-storage).

mod common;
use chronicle::capture::Engine;
use chronicle::config::Layers;
use chronicle::db::Index;
use common::{
    all_layers, line, test_config, tool_line, tool_result_line, tool_use_line, two_text_line,
};
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

/// FTS5 treats `-`, `"`, `*` etc. as operators; a raw term like `foo-bar` or an
/// unbalanced quote must not surface a bare rusqlite syntax error. Quoting the
/// term as a phrase literal makes such queries return cleanly (zero hits here).
#[test]
fn search_tolerates_fts_special_characters() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let session = write_session(&watch);

    let cfg = test_config(store.clone(), watch, all_layers());
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    let index = Index::open(&store.join("index.db")).unwrap();
    for q in ["foo-bar", "unbalanced \" quote", "a:b", "NEAR(", "*"] {
        assert!(index.search(q, 10).is_ok(), "query {q:?} must not error");
    }
}

/// A single transcript line with two `text` blocks shares one uuid. Both blocks
/// must land in the index — before per-block keying the second collided on
/// UNIQUE(session_id, uuid) and was silently dropped by INSERT OR IGNORE.
#[test]
fn multiple_text_blocks_on_one_line_are_all_indexed() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");
    let l = two_text_line("s1", "/home/me/proj", "alpha block", "omega block");
    fs::write(&session, format!("{l}\n")).unwrap();

    let cfg = test_config(store.clone(), watch, all_layers());
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    let index = Index::open(&store.join("index.db")).unwrap();
    assert_eq!(index.search("alpha", 10).unwrap().len(), 1, "first text block indexed");
    assert_eq!(index.search("omega", 10).unwrap().len(), 1, "second text block indexed");
}

/// A session's `raw_path` must point at its *main* transcript, never at a
/// subagent sidechain file. Sidechains carry the parent's `sessionId` (so they
/// fold into the same session) but live at `<id>/subagents/agent-*.jsonl`;
/// letting one set `raw_path` would clobber the pointer to a fragment. Both
/// sync orderings must converge to the main transcript.
#[test]
fn raw_path_points_at_main_transcript_not_sidechain() {
    for sidechain_first in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store");
        let watch = tmp.path().join("projects");
        let src = watch.join("proj");
        let sid = "11111111-1111-1111-1111-111111111111";
        // Main transcript is `<sid>.jsonl`; the sidechain lives under
        // `<sid>/subagents/` but its lines carry the same sessionId.
        let main = src.join(format!("{sid}.jsonl"));
        let side = src.join(sid).join("subagents").join("agent-x.jsonl");
        fs::create_dir_all(side.parent().unwrap()).unwrap();
        fs::write(&main, format!("{}\n", line(sid, "/home/me/proj", "user", "main convo"))).unwrap();
        fs::write(&side, format!("{}\n", line(sid, "/home/me/proj", "assistant", "subagent work"))).unwrap();

        let cfg = test_config(store.clone(), watch, all_layers());
        let mut engine = Engine::new(cfg).unwrap();
        let order: [&std::path::Path; 2] =
            if sidechain_first { [&side, &main] } else { [&main, &side] };
        for p in order {
            engine.sync_file(p).unwrap();
        }

        let index = Index::open(&store.join("index.db")).unwrap();
        let raw_path: Option<String> = index
            .conn
            .query_row("SELECT raw_path FROM sessions WHERE id = ?1", [sid], |r| r.get(0))
            .unwrap();
        let raw_path = raw_path.expect("session row has a raw_path");
        assert!(
            raw_path.ends_with(&format!("{sid}.jsonl")) && !raw_path.contains("subagents"),
            "raw_path must point at the main transcript (sidechain_first={sidechain_first}), got {raw_path}"
        );
    }
}

/// A tool-only row has empty `content`; its searchable text lives in
/// `tool_input`/`tool_output`. The snippet must come from the matched column,
/// not a blank column 0.
#[test]
fn search_snippet_falls_back_to_matched_tool_column() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");
    let l = tool_line("s1", "/home/me/proj", "Bash", "distinctivecommand");
    fs::write(&session, format!("{l}\n")).unwrap();

    let cfg = test_config(store.clone(), watch, all_layers());
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    let index = Index::open(&store.join("index.db")).unwrap();
    let hits = index.search("distinctivecommand", 10).unwrap();
    assert_eq!(hits.len(), 1, "tool input is searchable");
    assert!(
        hits[0].snippet.contains("distinctivecommand"),
        "snippet is drawn from the matched tool column, got {:?}",
        hits[0].snippet
    );
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

/// Excluded tools are omitted from *every* derived layer (markdown + index),
/// while raw keeps the original bytes. Regression test: markdown used to leak
/// excluded tools because the filter only guarded the SQLite layer.
#[test]
fn excluded_tools_omitted_from_all_derived_layers() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");

    let l1 = line("s1", "/home/me/proj", "user", "hello");
    let l2 = tool_line("s1", "/home/me/proj", "Bash", "rm -rf secret");
    let l3 = tool_line("s1", "/home/me/proj", "Read", "open the file");
    fs::write(&session, format!("{l1}\n{l2}\n{l3}\n")).unwrap();

    let mut cfg = test_config(store.clone(), watch, all_layers());
    cfg.exclude_tools = vec!["Bash".to_string()];
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    // Raw is untouched — the excluded tool's bytes are still there verbatim.
    let raw = fs::read_to_string(store.join("raw/proj/s.jsonl")).unwrap();
    assert!(raw.contains("Bash"), "raw archive keeps the excluded tool verbatim");

    // Markdown mirror omits the excluded tool but keeps the allowed one.
    let md = read_all_markdown(&store.join("markdown"));
    assert!(!md.contains("Bash"), "markdown must not leak the excluded tool");
    assert!(md.contains("Read"), "markdown keeps the allowed tool");

    // Index counts user text + the allowed Read (2), not the excluded Bash (3).
    let index = Index::open(&store.join("index.db")).unwrap();
    let sessions = index.recent_sessions(10).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].message_count, 2, "index omits the excluded tool row");
}

/// Excluding a tool must also drop that tool's *result* — which arrives on a
/// later transcript line and carries no tool name, only a `tool_use_id` linking
/// it back to the excluded call — from every derived layer, while raw keeps it.
#[test]
fn excluded_tool_result_omitted_from_derived_layers() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");

    let l1 = line("s1", "/home/me/proj", "user", "hello");
    let l2 = tool_use_line("s1", "/home/me/proj", "tu_bash", "Bash", "cat secret");
    let l3 = tool_result_line("s1", "/home/me/proj", "tu_bash", "SECRETOUTPUT");
    fs::write(&session, format!("{l1}\n{l2}\n{l3}\n")).unwrap();

    let mut cfg = test_config(store.clone(), watch, all_layers());
    cfg.exclude_tools = vec!["Bash".to_string()];
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    // Raw keeps the excluded tool's result verbatim.
    let raw = fs::read_to_string(store.join("raw/proj/s.jsonl")).unwrap();
    assert!(raw.contains("SECRETOUTPUT"), "raw archive keeps the excluded result");

    // Markdown mirror must not leak the excluded tool's output.
    let md = read_all_markdown(&store.join("markdown"));
    assert!(!md.contains("SECRETOUTPUT"), "markdown must not leak the excluded result");

    // Index must not surface the excluded tool's output either.
    let index = Index::open(&store.join("index.db")).unwrap();
    assert_eq!(
        index.search("SECRETOUTPUT", 10).unwrap().len(),
        0,
        "index must not contain the excluded result"
    );
}

/// A non-excluded tool's result is retained in the derived layers as normal.
#[test]
fn non_excluded_tool_result_is_retained() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");

    let l1 = tool_use_line("s1", "/home/me/proj", "tu_read", "Read", "open the file");
    let l2 = tool_result_line("s1", "/home/me/proj", "tu_read", "VISIBLEOUTPUT");
    fs::write(&session, format!("{l1}\n{l2}\n")).unwrap();

    let mut cfg = test_config(store.clone(), watch, all_layers());
    cfg.exclude_tools = vec!["Bash".to_string()];
    let mut engine = Engine::new(cfg).unwrap();
    engine.sync_file(&session).unwrap();

    let md = read_all_markdown(&store.join("markdown"));
    assert!(md.contains("VISIBLEOUTPUT"), "markdown keeps the allowed result");

    let index = Index::open(&store.join("index.db")).unwrap();
    assert_eq!(
        index.search("VISIBLEOUTPUT", 10).unwrap().len(),
        1,
        "index keeps the allowed result"
    );
}

/// Rebuild replays raw in order, so it reconstructs the same filtered derived
/// layers — both the excluded call and its result are absent after a rebuild.
#[test]
fn rebuild_reapplies_excluded_result_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let watch = tmp.path().join("projects");
    let src = watch.join("proj");
    fs::create_dir_all(&src).unwrap();
    let session = src.join("s.jsonl");

    let l1 = line("s1", "/home/me/proj", "user", "hello");
    let l2 = tool_use_line("s1", "/home/me/proj", "tu_bash", "Bash", "cat secret");
    let l3 = tool_result_line("s1", "/home/me/proj", "tu_bash", "SECRETOUTPUT");
    fs::write(&session, format!("{l1}\n{l2}\n{l3}\n")).unwrap();

    let mut cfg = test_config(store.clone(), watch, all_layers());
    cfg.exclude_tools = vec!["Bash".to_string()];
    cfg.save().unwrap(); // rebuild loads config from the store
    {
        let mut engine = Engine::new(cfg).unwrap();
        engine.sync_file(&session).unwrap();
    }

    // Nuke derived layers and rebuild purely from raw.
    fs::remove_file(store.join("index.db")).ok();
    fs::remove_dir_all(store.join("markdown")).ok();
    chronicle::commands::rebuild::rebuild(Some(store.clone())).unwrap();

    let md = read_all_markdown(&store.join("markdown"));
    assert!(!md.contains("SECRETOUTPUT"), "rebuilt markdown omits the excluded result");
    assert!(!md.contains("Bash"), "rebuilt markdown omits the excluded call");

    let index = Index::open(&store.join("index.db")).unwrap();
    assert_eq!(
        index.search("SECRETOUTPUT", 10).unwrap().len(),
        0,
        "rebuilt index omits the excluded result"
    );
}

fn read_all_markdown(dir: &std::path::Path) -> String {
    let mut out = String::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.push_str(&read_all_markdown(&p));
            } else if let Ok(s) = fs::read_to_string(&p) {
                out.push_str(&s);
            }
        }
    }
    out
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
