use super::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(rust_embed::Embed)]
#[folder = "frontend/"]
struct Frontend;

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/graph", get(get_graph))
        .route("/ws", get(ws_handler))
        .fallback(get(serve_frontend))
        .with_state(state)
        .layer(CorsLayer::permissive())
}

async fn get_graph(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(state.graph.clone())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    let msg = serde_json::json!({
        "type": "connected",
        "version": "0.1.0"
    });
    let _ = socket
        .send(Message::Text(msg.to_string().into()))
        .await;

    // Hold connection open, discard incoming messages
    while let Some(Ok(_)) = socket.recv().await {}
}

async fn serve_frontend(axum::extract::OriginalUri(uri): axum::extract::OriginalUri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Frontend::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                mime.parse().unwrap(),
            );
            (StatusCode::OK, headers, content.data.into_owned()).into_response()
        }
        None => {
            // SPA fallback: serve index.html
            match Frontend::get("index.html") {
                Some(content) => {
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        axum::http::header::CONTENT_TYPE,
                        "text/html; charset=utf-8".parse().unwrap(),
                    );
                    (StatusCode::OK, headers, content.data.into_owned()).into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
}
