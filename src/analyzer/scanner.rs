use super::graph::{Node, NodeKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &[".git", "target", "node_modules", "dist", ".next", "build"];

/// Returns (nodes, language_map) where language_map is file_path -> language
pub fn scan(root: &Path) -> anyhow::Result<(Vec<Node>, HashMap<String, String>)> {
    let mut nodes: Vec<Node> = Vec::new();
    let mut language_map: HashMap<String, String> = HashMap::new();

    // Collect all relevant files first
    let mut rs_files: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new(); // module_dir -> files
    let mut ts_files: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut standalone_rs: Vec<PathBuf> = Vec::new();
    let mut standalone_ts: Vec<PathBuf> = Vec::new();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path().to_path_buf();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        match ext.as_str() {
            "rs" => {
                let parent = path.parent().unwrap_or(root).to_path_buf();
                rs_files.entry(parent).or_default().push(path);
            }
            "ts" | "tsx" => {
                let parent = path.parent().unwrap_or(root).to_path_buf();
                ts_files.entry(parent).or_default().push(path);
            }
            _ => {}
        }
    }

    // Detect Rust modules: dirs that contain mod.rs or lib.rs
    for (dir, files) in &rs_files {
        let has_mod = files
            .iter()
            .any(|f| matches!(f.file_name().and_then(|n| n.to_str()), Some("mod.rs") | Some("lib.rs") | Some("main.rs")));

        if has_mod {
            // This dir is a module
            let rel_dir = dir.strip_prefix(root).unwrap_or(dir);
            let id = if rel_dir == Path::new("") {
                "src".to_string()
            } else {
                rel_dir.to_string_lossy().into_owned()
            };

            let label = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| id.clone());

            let cluster = rel_dir
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            let mut line_count = 0u32;
            let mut file_paths: Vec<String> = Vec::new();

            for file in files {
                let lines = count_lines(file);
                line_count += lines;
                let rel_file = file.strip_prefix(root).unwrap_or(file);
                let rel_str = rel_file.to_string_lossy().into_owned();
                language_map.insert(rel_str.clone(), "rust".to_string());
                file_paths.push(rel_str);
            }

            nodes.push(Node {
                id: id.clone(),
                label,
                kind: NodeKind::Module,
                language: "rust".to_string(),
                cluster,
                file_count: files.len() as u32,
                line_count,
                files: file_paths,
            });
        } else {
            // Standalone files
            for file in files {
                standalone_rs.push(file.clone());
            }
        }
    }

    // Add standalone Rust files that aren't part of a module dir
    for file in standalone_rs {
        let rel_file = file.strip_prefix(root).unwrap_or(&file);
        let id = rel_file.to_string_lossy().into_owned();
        let label = file
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone());
        let cluster = rel_file
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let line_count = count_lines(&file);

        language_map.insert(id.clone(), "rust".to_string());

        nodes.push(Node {
            id: id.clone(),
            label,
            kind: NodeKind::File,
            language: "rust".to_string(),
            cluster,
            file_count: 1,
            line_count,
            files: vec![id],
        });
    }

    // Detect TS modules: dirs that contain index.ts or index.tsx
    for (dir, files) in &ts_files {
        let has_index = files.iter().any(|f| {
            matches!(
                f.file_name().and_then(|n| n.to_str()),
                Some("index.ts") | Some("index.tsx")
            )
        });

        if has_index {
            let rel_dir = dir.strip_prefix(root).unwrap_or(dir);
            let id = rel_dir.to_string_lossy().into_owned();

            let label = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| id.clone());

            let cluster = rel_dir
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            let mut line_count = 0u32;
            let mut file_paths: Vec<String> = Vec::new();

            for file in files {
                let lines = count_lines(file);
                line_count += lines;
                let rel_file = file.strip_prefix(root).unwrap_or(file);
                let rel_str = rel_file.to_string_lossy().into_owned();
                let lang = if rel_str.ends_with(".tsx") {
                    "tsx"
                } else {
                    "typescript"
                };
                language_map.insert(rel_str.clone(), lang.to_string());
                file_paths.push(rel_str);
            }

            nodes.push(Node {
                id: id.clone(),
                label,
                kind: NodeKind::Module,
                language: "typescript".to_string(),
                cluster,
                file_count: files.len() as u32,
                line_count,
                files: file_paths,
            });
        } else {
            for file in files {
                standalone_ts.push(file.clone());
            }
        }
    }

    // Add standalone TS files
    for file in standalone_ts {
        let rel_file = file.strip_prefix(root).unwrap_or(&file);
        let id = rel_file.to_string_lossy().into_owned();
        let label = file
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone());
        let cluster = rel_file
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let line_count = count_lines(&file);
        let lang = if id.ends_with(".tsx") {
            "tsx"
        } else {
            "typescript"
        };
        language_map.insert(id.clone(), lang.to_string());

        nodes.push(Node {
            id: id.clone(),
            label,
            kind: NodeKind::File,
            language: lang.to_string(),
            cluster,
            file_count: 1,
            line_count,
            files: vec![id],
        });
    }

    Ok((nodes, language_map))
}

fn count_lines(path: &Path) -> u32 {
    use std::io::{BufRead, BufReader};
    match std::fs::File::open(path) {
        Ok(f) => BufReader::new(f).lines().count() as u32,
        Err(_) => 0,
    }
}



