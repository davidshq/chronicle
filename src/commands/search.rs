//! `chronicle search <query>` — FTS query over captured sessions.

use crate::db::Index;
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct SearchArgs {
    /// Search terms (matched as a phrase; special characters are literal).
    query: String,
    #[arg(long)]
    store: Option<PathBuf>,
    #[arg(long, default_value_t = 20)]
    limit: usize,
    #[arg(long)]
    json: bool,
}

pub fn run(args: SearchArgs) -> Result<()> {
    let cfg = super::load_config(args.store)?;
    let db_path = cfg.store_dir.join("index.db");
    if !db_path.exists() {
        println!("No index yet — is the daemon running? (chronicle status)");
        return Ok(());
    }
    let index = Index::open(&db_path)?;
    let hits = match index.search(&args.query, args.limit) {
        Ok(hits) => hits,
        Err(_) => {
            println!("Search failed. If your query has unusual characters, try simpler terms; otherwise the index may be corrupt — try `chronicle rebuild`.");
            return Ok(());
        }
    };

    if args.json {
        let items: Vec<_> = hits
            .iter()
            .map(|h| {
                serde_json::json!({
                    "session_id": h.session_id,
                    "project_path": h.project_path,
                    "timestamp": h.timestamp,
                    "role": h.role,
                    "snippet": h.snippet,
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&items)?);
        return Ok(());
    }

    if hits.is_empty() {
        println!("No matches for {:?}.", args.query);
        return Ok(());
    }
    println!("{} match(es) for {:?}:\n", hits.len(), args.query);
    for h in hits {
        let project = h.project_path.rsplit('/').next().unwrap_or(&h.project_path);
        println!("• [{}] {} ({})\n    {}", h.role, project, h.timestamp, h.snippet.replace('\n', " "));
    }
    Ok(())
}
