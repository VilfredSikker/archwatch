use crate::analyzer::GraphData;
use std::path::PathBuf;
use tokio::sync::{broadcast, RwLock};

/// Shared application state passed to all request handlers.
pub struct AppState {
    pub graph: RwLock<GraphData>,
    pub broadcast_tx: broadcast::Sender<String>,
    pub watch_root: PathBuf,
    pub flatten: Vec<String>,
}



