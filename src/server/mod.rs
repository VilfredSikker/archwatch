mod routes;
mod state;

pub use state::AppState;

use crate::analyzer::GraphData;
use std::sync::Arc;

pub async fn serve(graph: GraphData, addr: &str) -> anyhow::Result<()> {
    let state = Arc::new(AppState { graph });
    let app = routes::build_router(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
