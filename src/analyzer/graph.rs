use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub metadata: GraphMetadata,
}

#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    pub language: String,
    pub cluster: String,
    pub file_count: u32,
    pub line_count: u32,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Module,
    File,
}

#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub weight: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphMetadata {
    pub root: String,
    pub total_lines: u32,
    pub total_files: u32,
    pub languages: Vec<String>,
    pub analysis_ms: u64,
}
