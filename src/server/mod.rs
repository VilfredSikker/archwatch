mod routes;
mod state;

pub use state::AppState;

use crate::analyzer::{self, GraphData};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

pub async fn serve(graph: GraphData, addr: &str, watch_root: PathBuf) -> anyhow::Result<()> {
    let (broadcast_tx, _) = broadcast::channel::<String>(64);

    let state = Arc::new(AppState {
        graph: tokio::sync::RwLock::new(graph),
        broadcast_tx: broadcast_tx.clone(),
        watch_root: watch_root.clone(),
    });

    let state_for_watcher = Arc::clone(&state);
    tokio::spawn(async move {
        let mut rx = crate::watcher::watch(watch_root);
        while let Some(changed_paths) = rx.recv().await {
            let modified_files: Vec<String> = changed_paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();

            let root = state_for_watcher.watch_root.clone();

            let modified_files_rel: Vec<String> = changed_paths
                .iter()
                .filter_map(|p| p.strip_prefix(&root).ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            match analyzer::analyze(&root) {
                Ok(new_graph) => {
                    let affected_nodes: Vec<String> = {
                        let old_graph = state_for_watcher.graph.read().await;
                        new_graph
                            .nodes
                            .iter()
                            .filter(|n| {
                                !old_graph
                                    .nodes
                                    .iter()
                                    .any(|old| old.id == n.id && old.line_count == n.line_count)
                            })
                            .map(|n| n.id.clone())
                            .collect()
                    };

                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    let msg = serde_json::json!({
                        "type": "graph_update",
                        "graph": {
                            "nodes": new_graph.nodes,
                            "edges": new_graph.edges,
                            "metadata": new_graph.metadata
                        },
                        "changes": {
                            "modified_files": modified_files,
                            "modified_files_rel": modified_files_rel,
                            "affected_nodes": affected_nodes,
                            "timestamp": timestamp
                        }
                    });

                    {
                        let mut graph = state_for_watcher.graph.write().await;
                        *graph = new_graph;
                    }

                    let _ = state_for_watcher.broadcast_tx.send(msg.to_string());
                }
                Err(e) => {
                    eprintln!("watcher: re-analyze failed: {e}");
                }
            }
        }
    });

    let app = routes::build_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

