mod graph;
mod rust_parser;
mod scanner;
mod ts_parser;

pub use graph::GraphData;

use std::path::Path;
use std::time::Instant;

pub fn analyze(path: &Path) -> anyhow::Result<GraphData> {
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
    let edges: Vec<graph::Edge> = edge_map
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

    // Sort nodes for deterministic output
    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(GraphData {
        nodes,
        edges,
        metadata,
    })
}
