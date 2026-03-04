mod graph;
mod rust_parser;
mod scanner;
mod ts_parser;

pub use graph::{GraphData, Node};

use std::path::Path;
use std::time::Instant;

pub fn analyze(path: &Path, flatten: &[String]) -> anyhow::Result<GraphData> {
    let start = Instant::now();

    let (mut nodes, language_map) = scanner::scan(path)?;

    let mut all_edges: Vec<graph::Edge> = Vec::new();

    let rust_edges = rust_parser::extract_edges(path, &nodes, &language_map)?;
    all_edges.extend(rust_edges);

    let ts_edges = ts_parser::extract_edges(path, &nodes, &language_map)?;
    all_edges.extend(ts_edges);

    // Deduplicate edges and accumulate weight
    let mut edge_map: std::collections::HashMap<(String, String), u32> =
        std::collections::HashMap::new();
    for edge in all_edges {
        if edge.source != edge.target {
            *edge_map
                .entry((edge.source.clone(), edge.target.clone()))
                .or_insert(0) += edge.weight;
        }
    }
    let mut edges: Vec<graph::Edge> = edge_map
        .into_iter()
        .map(|((source, target), weight)| graph::Edge {
            source,
            target,
            weight,
        })
        .collect();

    let total_lines: u32 = nodes.iter().map(|n| n.line_count).sum();
    let total_files: u32 = nodes.iter().map(|n| n.file_count).sum();

    let mut languages: Vec<String> = nodes
        .iter()
        .map(|n| n.language.clone())
        .filter(|l| !l.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    languages.sort();

    let root = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let analysis_ms = start.elapsed().as_millis() as u64;

    let metadata = graph::GraphMetadata {
        root,
        total_lines,
        total_files,
        languages,
        analysis_ms,
    };

    // Flatten configured directories: remove the container node, promote children
    for prefix in flatten {
        // Remove the container module node
        nodes.retain(|n| n.id != *prefix);

        // Strip prefix from child node IDs, clusters, and file paths
        let prefix_slash = format!("{}/", prefix);
        for node in &mut nodes {
            if node.id.starts_with(&prefix_slash) {
                node.id = node.id[prefix_slash.len()..].to_string();
            }
            if node.cluster.starts_with(&prefix_slash) {
                node.cluster = node.cluster[prefix_slash.len()..].to_string();
            } else if node.cluster == *prefix {
                node.cluster = String::new();
            }
            node.files = node
                .files
                .iter()
                .map(|f| {
                    if f.starts_with(&prefix_slash) {
                        f[prefix_slash.len()..].to_string()
                    } else {
                        f.clone()
                    }
                })
                .collect();
        }

        // Update edge references
        edges.retain(|e| e.source != *prefix && e.target != *prefix);
        for edge in &mut edges {
            if edge.source.starts_with(&prefix_slash) {
                edge.source = edge.source[prefix_slash.len()..].to_string();
            }
            if edge.target.starts_with(&prefix_slash) {
                edge.target = edge.target[prefix_slash.len()..].to_string();
            }
        }

        // Re-deduplicate edges after prefix stripping (stripping may create duplicates)
        let mut edge_map: std::collections::HashMap<(String, String), u32> =
            std::collections::HashMap::new();
        for edge in edges.drain(..) {
            if edge.source != edge.target {
                *edge_map
                    .entry((edge.source, edge.target))
                    .or_insert(0) += edge.weight;
            }
        }
        edges.extend(edge_map.into_iter().map(|((source, target), weight)| graph::Edge {
            source,
            target,
            weight,
        }));
    }

    // Sort nodes for deterministic output
    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(GraphData {
        nodes,
        edges,
        metadata,
    })
}
