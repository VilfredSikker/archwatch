use super::state::AppState;
use crate::git_diff;
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
        .route("/api/branch-diff", get(get_branch_diff))
        .route("/ws", get(ws_handler))
        .fallback(get(serve_frontend))
        .with_state(state)
        .layer(CorsLayer::permissive())
}

#[derive(serde::Deserialize)]
struct BranchDiffQuery {
    base: Option<String>,
}

async fn get_branch_diff(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<BranchDiffQuery>,
) -> impl IntoResponse {
    let base = query.base.unwrap_or_else(|| "main".to_string());
    match git_diff::diff_against_branch(&state.watch_root, &base) {
        Ok(diff) => {
            let response = serde_json::json!({
                "type": "branch_diff",
                "diff": diff
            });
            axum::Json(response).into_response()
        }
        Err(e) => {
            let error = serde_json::json!({
                "error": format!("Failed to compute diff: {}", e)
            });
            (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(error)).into_response()
        }
    }
}

async fn get_graph(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let graph = state.graph.read().await;
    axum::Json(graph.clone())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let connected_msg = serde_json::json!({
        "type": "connected",
        "version": "0.1.0"
    });
    if socket
        .send(Message::Text(connected_msg.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let mut rx = state.broadcast_tx.subscribe();

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                if client_msg.is_none() {
                    break;
                }
            }
        }
    }
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
        None => match Frontend::get("index.html") {
            Some(content) => {
                let mut headers = HeaderMap::new();
                headers.insert(
                    axum::http::header::CONTENT_TYPE,
                    "text/html; charset=utf-8".parse().unwrap(),
                );
                (StatusCode::OK, headers, content.data.into_owned()).into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
    }
}




