use std::collections::HashMap;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use futures_util::StreamExt;
use tokio::sync::broadcast;

use crate::{auth, error::AppError, events::TaskEvent, AppState};

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let Some(api_key) = query.get("api_key") else {
        return Err(AppError::Unauthorized);
    };

    let key_exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM api_keys WHERE key_hash = ?")
        .bind(auth::hash_key(api_key))
        .fetch_optional(&state.pool)
        .await
        .map_err(AppError::Internal)?
        .is_some();
    if !key_exists {
        return Err(AppError::Unauthorized);
    }

    let events = state.events.subscribe();
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, events)))
}

async fn handle_socket(mut socket: WebSocket, mut events: broadcast::Receiver<TaskEvent>) {
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(message) = serde_json::to_string(&event) else {
                        continue;
                    };
                    if socket.send(Message::Text(message)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            client_message = socket.next() => match client_message {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
}
