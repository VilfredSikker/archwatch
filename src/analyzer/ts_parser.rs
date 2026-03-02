use super::graph::{Edge, Node};
use std::collections::HashMap;
use std::path::Path;
use tree_sitter::Parser;

pub fn extract_edges(
    root: &Path,
    nodes: &[Node],
    language_map: &HashMap<String, String>,
) -> anyhow::Result<Vec<Edge>> {
    let mut ts_parser = Parser::new();
    let ts_language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT;
    ts_parser
        .set_language(&ts_language.into())
        .map_err(|e| anyhow::anyhow!("Failed to set TypeScript language: {}", e))?;

    let mut tsx_parser = Parser::new();
    let tsx_language = tree_sitter_typescript::LANGUAGE_TSX;
    tsx_parser
        .set_language(&tsx_language.into())
        .map_err(|e| anyhow::anyhow!("Failed to set TSX language: {}", e))?;

    let file_to_node = build_file_to_node(nodes);
    let mut edges: Vec<Edge> = Vec::new();

    let ts_files: Vec<(String, String)> = language_map
        .iter()
        .filter(|(_, lang)| lang.as_str() == "typescript" || lang.as_str() == "tsx")
        .map(|(path, lang)| (path.clone(), lang.clone()))
        .collect();

    for (rel_path, lang) in ts_files {
        let abs_path = root.join(&rel_path);
        let source_code = match std::fs::read_to_string(&abs_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let parser = if lang == "tsx" {
            &mut tsx_parser
        } else {
            &mut ts_parser
        };

        let tree = match parser.parse(&source_code, None) {
            Some(t) => t,
            None => continue,
        };

        let source_node_id = file_to_node
            .get(rel_path.as_str())
            .cloned()
            .unwrap_or_else(|| rel_path.clone());

        let imports = extract_ts_imports(&tree, &source_code);

        for import_specifier in imports {
            if let Some(target_id) =
                resolve_ts_import(&import_specifier, &rel_path, root, nodes, &file_to_node)
            {
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

fn extract_ts_imports(tree: &tree_sitter::Tree, source: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let mut cursor = tree.walk();
    traverse_ts_tree(&mut cursor, source, &mut imports);
    imports
}

fn traverse_ts_tree(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    imports: &mut Vec<String>,
) {
    let node = cursor.node();

    match node.kind() {
        "import_statement" => {
            // import ... from '...'
            if let Some(specifier) = find_import_source(node, source) {
                imports.push(specifier);
            }
        }
        "call_expression" => {
            // require('...')
            if let Some(specifier) = find_require_call(node, source) {
                imports.push(specifier);
            }
        }
        _ => {}
    }

    if cursor.goto_first_child() {
        loop {
            traverse_ts_tree(cursor, source, imports);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        cursor.goto_parent();
    }
}

fn find_import_source(node: tree_sitter::Node, source: &str) -> Option<String> {
    for i in 0..node.child_count() {
        let child = node.child(i)?;
        if child.kind() == "string" {
            let text = &source[child.byte_range()];
            let trimmed = text.trim_matches('"').trim_matches('\'');
            return Some(trimmed.to_string());
        }
    }
    None
}

fn find_require_call(node: tree_sitter::Node, source: &str) -> Option<String> {
    let func = node.child(0)?;
    let func_text = &source[func.byte_range()];
    if func_text != "require" {
        return None;
    }

    let args = node.child(1)?;
    if args.kind() != "arguments" {
        return None;
    }

    for i in 0..args.child_count() {
        let child = args.child(i)?;
        if child.kind() == "string" {
            let text = &source[child.byte_range()];
            let trimmed = text.trim_matches('"').trim_matches('\'');
            return Some(trimmed.to_string());
        }
    }
    None
}

fn resolve_ts_import(
    specifier: &str,
    source_rel_path: &str,
    root: &Path,
    nodes: &[Node],
    file_to_node: &HashMap<String, String>,
) -> Option<String> {
    // Skip bare specifiers (npm packages)
    if !specifier.starts_with('.') && !specifier.starts_with('/') {
        return None;
    }

    let source_dir = Path::new(source_rel_path).parent()?;
    let resolved = source_dir.join(specifier);

    // Normalize the path (handle ..)
    let normalized = normalize_path(&resolved);

    // Try various extensions and index files
    let candidates = vec![
        normalized.clone(),
        format!("{}.ts", normalized),
        format!("{}.tsx", normalized),
        format!("{}/index.ts", normalized),
        format!("{}/index.tsx", normalized),
    ];

    for candidate in &candidates {
        // Check if this is a known file
        if let Some(node_id) = file_to_node.get(candidate.as_str()) {
            return Some(node_id.clone());
        }
    }

    // Try to match against node IDs directly
    for candidate in &candidates {
        for node in nodes {
            if &node.id == candidate || node.files.contains(candidate) {
                return Some(node.id.clone());
            }
        }
    }

    // Try matching the directory as a module node
    for node in nodes {
        if node.id == normalized {
            return Some(node.id.clone());
        }
    }

    // Check if the actual file exists under root
    for candidate in &candidates {
        let abs = root.join(candidate);
        if abs.exists() {
            return Some(candidate.clone());
        }
    }

    None
}

/// Normalize a path string by resolving ".." components without touching the filesystem
fn normalize_path(path: &Path) -> String {
    let mut components: Vec<String> = Vec::new();
    for component in path.components() {
        let s = component.as_os_str().to_string_lossy();
        match s.as_ref() {
            ".." => {
                components.pop();
            }
            "." => {}
            c => {
                components.push(c.to_string());
            }
        }
    }
    components.join("/")
}
