mod routes;
mod state;

pub use state::AppState;

use crate::analyzer::{self, GraphData, Node};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

pub async fn serve(graph: GraphData, listener: tokio::net::TcpListener, watch_root: PathBuf, flatten: Vec<String>) -> anyhow::Result<()> {
    let (broadcast_tx, _) = broadcast::channel::<String>(64);

    let state = Arc::new(AppState {
        graph: tokio::sync::RwLock::new(graph),
        broadcast_tx: broadcast_tx.clone(),
        watch_root: watch_root.clone(),
        flatten,
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
            match analyzer::analyze(&root, &state_for_watcher.flatten) {
                Ok(new_graph) => {
                    let affected_nodes: Vec<String> = {
                        let old_graph = state_for_watcher.graph.read().await;

                        // Index old nodes by id for O(1) lookup
                        let old_nodes_by_id: HashMap<&str, &Node> = old_graph
                            .nodes
                            .iter()
                            .map(|n| (n.id.as_str(), n))
                            .collect();

                        // Nodes that were added or changed (full PartialEq comparison)
                        let mut affected: HashSet<String> = new_graph
                            .nodes
                            .iter()
                            .filter(|n| {
                                old_nodes_by_id
                                    .get(n.id.as_str())
                                    .map_or(true, |old| *old != *n)
                            })
                            .map(|n| n.id.clone())
                            .collect();

                        // Build edge sets for old and new graphs
                        let old_edges: HashSet<(&str, &str)> = old_graph
                            .edges
                            .iter()
                            .map(|e| (e.source.as_str(), e.target.as_str()))
                            .collect();
                        let new_edges: HashSet<(&str, &str)> = new_graph
                            .edges
                            .iter()
                            .map(|e| (e.source.as_str(), e.target.as_str()))
                            .collect();

                        // Edges added or removed — mark their source and target nodes as affected
                        for (src, tgt) in old_edges.symmetric_difference(&new_edges) {
                            affected.insert(src.to_string());
                            affected.insert(tgt.to_string());
                        }

                        affected.into_iter().collect()
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
    axum::serve(listener, app).await?;

    Ok(())
}

