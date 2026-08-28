use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

mod support;

#[tokio::test]
async fn task_creation_is_broadcast_over_websocket() {
    let router = ai_task_tracker::build_router(support::state().await);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let base_url = format!("http://{address}");
    let client = reqwest::Client::new();

    let project: Value = client
        .post(format!("{base_url}/api/projects"))
        .header("x-api-key", "test-key")
        .json(&json!({"name": "Tracker"}))
        .send()
        .await
        .expect("project request should complete")
        .error_for_status()
        .expect("project request should succeed")
        .json()
        .await
        .expect("project response should be JSON");

    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://{address}/ws?api_key=test-key"))
            .await
            .expect("websocket should connect");

    let task: Value = client
        .post(format!("{base_url}/api/tasks"))
        .header("x-api-key", "test-key")
        .json(&json!({
            "project_id": project["id"],
            "title": "Broadcast task"
        }))
        .send()
        .await
        .expect("task request should complete")
        .error_for_status()
        .expect("task request should succeed")
        .json()
        .await
        .expect("task response should be JSON");

    let message = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .expect("websocket should receive an event")
        .expect("websocket should remain open")
        .expect("websocket message should be valid");
    let Message::Text(message) = message else {
        panic!("expected a text websocket message");
    };
    let event: Value = serde_json::from_str(&message).expect("event should be JSON");
    assert_eq!(event["type"], "task_created");
    assert_eq!(event["task"]["id"], task["id"]);

    server.abort();
}
