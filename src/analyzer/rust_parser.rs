use super::graph::{Edge, Node};
use std::collections::HashMap;
use std::path::Path;
use tree_sitter::Parser;

pub fn extract_edges(
    root: &Path,
    nodes: &[Node],
    language_map: &HashMap<String, String>,
) -> anyhow::Result<Vec<Edge>> {
    let mut parser = Parser::new();
    let language = tree_sitter_rust::LANGUAGE;
    parser
        .set_language(&language.into())
        .map_err(|e| anyhow::anyhow!("Failed to set Rust language: {}", e))?;

    // Build a quick lookup: file path -> node id
    let file_to_node = build_file_to_node(nodes);
    // Build a lookup: crate-style path -> node id for O(1) import resolution
    let node_by_path = build_node_by_path(nodes);

    let mut edges: Vec<Edge> = Vec::new();

    let rust_files: Vec<String> = language_map
        .iter()
        .filter(|(_, lang)| lang.as_str() == "rust")
        .map(|(path, _)| path.clone())
        .collect();

    for rel_path in rust_files {
        let abs_path = root.join(&rel_path);
        let source_code = match std::fs::read_to_string(&abs_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let tree = match parser.parse(&source_code, None) {
            Some(t) => t,
            None => continue,
        };

        let source_node_id = file_to_node
            .get(rel_path.as_str())
            .cloned()
            .unwrap_or_else(|| rel_path.clone());

        let imports = extract_rust_imports(&tree, &source_code);

        for import_path in imports {
            if let Some(target_id) = resolve_rust_import(&import_path, &node_by_path) {
                if target_id != source_node_id {
                    edges.push(Edge {
                        source: source_node_id.clone(),
                        target: target_id,
                        weight: 1,
                    });
                }
            }
        }
    }

    Ok(edges)
}

fn build_file_to_node(nodes: &[Node]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for node in nodes {
        for file in &node.files {
            map.insert(file.clone(), node.id.clone());
        }
    }
    map
}

/// Maps crate-style paths (e.g. "foo/bar", "foo") to node IDs for O(1) import resolution.
fn build_node_by_path(nodes: &[Node]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for node in nodes {
        // Key by the id without a leading "src/" so it aligns with crate:: path parts
        let key = node.id.trim_start_matches("src/").to_string();
        map.insert(key, node.id.clone());
        // Also key by label for single-component fallback
        map.entry(node.label.clone()).or_insert_with(|| node.id.clone());
    }
    map
}

fn extract_rust_imports(tree: &tree_sitter::Tree, source: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let mut cursor = tree.walk();

    traverse_tree(&mut cursor, source, &mut imports);

    imports
}

fn traverse_tree(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    imports: &mut Vec<String>,
) {
    let node = cursor.node();

    match node.kind() {
        "use_declaration" => {
            let text = &source[node.byte_range()];
            // Extract path from use statement
            for import in parse_use_declaration(text) {
                imports.push(import);
            }
        }
        "mod_item" => {
            // mod foo; — local module declaration
            let text = &source[node.byte_range()];
            if let Some(mod_name) = parse_mod_item(text) {
                imports.push(format!("mod::{}", mod_name));
            }
        }
        _ => {}
    }

    if cursor.goto_first_child() {
        loop {
            traverse_tree(cursor, source, imports);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        cursor.goto_parent();
    }
}

fn parse_use_declaration(text: &str) -> Vec<String> {
    let text = text.trim();
    // Remove "use " prefix and trailing ";"
    let text = text
        .strip_prefix("use ")
        .unwrap_or(text)
        .trim_end_matches(';')
        .trim();

    // Only process crate:: paths
    if text.starts_with("crate::") {
        vec![text.to_string()]
    } else {
        vec![]
    }
}

fn parse_mod_item(text: &str) -> Option<String> {
    let text = text.trim();
    // mod foo; (not mod foo { ... })
    if text.ends_with(';') {
        let inner = text
            .strip_prefix("pub(crate) ")
            .or_else(|| text.strip_prefix("pub "))
            .unwrap_or(text);
        let inner = inner
            .strip_prefix("mod ")
            .unwrap_or(inner)
            .trim_end_matches(';')
            .trim();
        if !inner.contains('{') && !inner.contains(' ') {
            return Some(inner.to_string());
        }
    }
    None
}

fn resolve_rust_import(import_path: &str, node_by_path: &HashMap<String, String>) -> Option<String> {
    if !import_path.starts_with("crate::") {
        return None;
    }

    let inner = import_path.strip_prefix("crate::").unwrap_or(import_path);
    let path_parts: Vec<&str> = inner.split("::").collect();

    // Try progressively shorter prefixes: foo/bar/baz → foo/bar → foo
    for len in (1..=path_parts.len()).rev() {
        let candidate = path_parts[..len].join("/");
        if let Some(node_id) = node_by_path.get(&candidate) {
            return Some(node_id.clone());
        }
    }

    None
}


