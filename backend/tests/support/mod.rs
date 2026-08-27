use ai_task_tracker::{auth::hash_key, db, AppState};
use axum::{
    body::Body,
    http::{Method, Request},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::Value;
use std::path::PathBuf;

pub async fn state() -> AppState {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    db::migrate(&pool).await.unwrap();
    sqlx::query("INSERT INTO api_keys (id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hash_key("test-key"))
        .bind("test")
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    AppState { pool }
}

#[allow(dead_code)]
pub async fn file_state() -> (AppState, PathBuf) {
    let path = std::env::temp_dir().join(format!("ai-task-tracker-{}.db", uuid::Uuid::new_v4()));
    let pool = db::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    db::migrate(&pool).await.unwrap();
    sqlx::query("INSERT INTO api_keys (id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hash_key("test-key"))
        .bind("test")
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    (AppState { pool }, path)
}

#[allow(dead_code)]
pub fn api_request(method: Method, uri: &str, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-api-key", "test-key");
    let body = match body {
        Some(body) => {
            builder = builder.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

pub async fn json_body(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}
