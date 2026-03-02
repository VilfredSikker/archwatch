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
            if let Some(target_id) = resolve_rust_import(&import_path, root, nodes) {
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
            .strip_prefix("pub ")
            .unwrap_or(text)
            .strip_prefix("pub(crate) ")
            .unwrap_or(text)
            .strip_prefix("mod ")
            .unwrap_or(text)
            .trim_end_matches(';')
            .trim();
        if !inner.contains('{') && !inner.contains(' ') {
            return Some(inner.to_string());
        }
    }
    None
}

fn resolve_rust_import(import_path: &str, _root: &Path, nodes: &[Node]) -> Option<String> {
    if import_path.starts_with("crate::") {
        let path_parts: Vec<&str> = import_path
            .strip_prefix("crate::")
            .unwrap_or(import_path)
            .split("::")
            .collect();

        // Try to match against known node IDs
        // A crate::foo::bar import likely maps to src/foo/bar or src/foo
        for node in nodes {
            let node_parts: Vec<&str> = node
                .id
                .trim_start_matches("src/")
                .split('/')
                .collect();

            // Check if import path parts match node id parts
            if path_parts.len() >= node_parts.len() {
                let matches = path_parts
                    .iter()
                    .zip(node_parts.iter())
                    .all(|(a, b)| a == b);
                if matches {
                    return Some(node.id.clone());
                }
            }
        }

        // Fallback: try to find a node matching the first component
        if let Some(first) = path_parts.first() {
            for node in nodes {
                if node.id.ends_with(first) || node.label == *first {
                    return Some(node.id.clone());
                }
            }
        }
    }
    None
}


