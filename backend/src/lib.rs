use axum::{
    http::StatusCode,
    middleware,
    routing::{delete, get, post},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::{LocalSessionManager, SessionConfig},
    StreamableHttpServerConfig, StreamableHttpService,
};
use std::time::Duration;

pub mod auth;
pub mod db;
pub mod error;
pub mod events;
pub mod handlers;
pub mod mcp;
pub mod models;
pub mod static_files;
pub mod ws;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
    pub events: tokio::sync::broadcast::Sender<events::TaskEvent>,
}

const DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS: u64 = 1800;

fn mcp_session_keep_alive_from_env() -> Duration {
    let seconds = std::env::var("MCP_SESSION_KEEP_ALIVE_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS);
    Duration::from_secs(seconds)
}

pub fn build_router(state: AppState) -> Router {
    build_router_with_mcp_session_config(
        state,
        SessionConfig {
            keep_alive: Some(mcp_session_keep_alive_from_env()),
            ..Default::default()
        },
    )
}

fn build_router_with_mcp_session_config(state: AppState, session_config: SessionConfig) -> Router {
    let api = Router::new()
        .route(
            "/projects",
            get(handlers::projects::list_projects).post(handlers::projects::create_project),
        )
        .route(
            "/projects/:id",
            get(handlers::projects::get_project)
                .patch(handlers::projects::update_project)
                .delete(handlers::projects::delete_project),
        )
        .route("/tasks", post(handlers::tasks::create_task))
        .route(
            "/tasks/:id",
            get(handlers::tasks::get_task)
                .patch(handlers::tasks::update_task)
                .delete(handlers::tasks::delete_task),
        )
        .route(
            "/projects/:id/tasks",
            get(handlers::tasks::list_project_tasks),
        )
        .route("/tasks/:id/status", post(handlers::tasks::transition_task))
        .route(
            "/tasks/:id/logs",
            get(handlers::tasks::list_logs).post(handlers::tasks::create_log),
        )
        .route("/tasks/:id/tags", post(handlers::tasks::attach_tag))
        .route(
            "/tasks/:id/tags/:tag_id",
            delete(handlers::tasks::remove_tag),
        )
        .route("/tags", get(handlers::tags::list_tags))
        .route(
            "/tasks/needs-attention",
            get(handlers::tasks::list_attention),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn(error::normalize_api_errors))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    let mcp_pool = state.pool.clone();
    let mcp_events = state.events.clone();
    let mcp: Router<AppState> = Router::new()
        .nest_service(
            "/mcp",
            StreamableHttpService::new(
                move || {
                    Ok(mcp::TaskMcpServer::new(
                        mcp_pool.clone(),
                        mcp_events.clone(),
                    ))
                },
                LocalSessionManager {
                    session_config,
                    ..Default::default()
                }
                .into(),
                StreamableHttpServerConfig::default(),
            ),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", api)
        .merge(mcp)
        .fallback(static_files::serve)
        .with_state(state)
}

#[cfg(test)]
fn build_router_with_mcp_session_timeout(
    state: AppState,
    keep_alive: std::time::Duration,
) -> Router {
    build_router_with_mcp_session_config(
        state,
        SessionConfig {
            keep_alive: Some(keep_alive),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rmcp::model::ClientInfo;

    use super::*;

    async fn test_state() -> AppState {
        let pool = db::connect("sqlite::memory:").await.unwrap();
        db::migrate(&pool).await.unwrap();
        sqlx::query("INSERT INTO api_keys (id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(auth::hash_key("test-key"))
            .bind("test")
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .unwrap();
        AppState {
            pool,
            events: tokio::sync::broadcast::channel(256).0,
        }
    }

    #[test]
    fn mcp_session_keep_alive_uses_environment_or_default() {
        std::env::remove_var("MCP_SESSION_KEEP_ALIVE_SECS");
        assert_eq!(
            mcp_session_keep_alive_from_env(),
            Duration::from_secs(DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS)
        );

        std::env::set_var("MCP_SESSION_KEEP_ALIVE_SECS", "42");
        assert_eq!(mcp_session_keep_alive_from_env(), Duration::from_secs(42));

        std::env::set_var("MCP_SESSION_KEEP_ALIVE_SECS", "invalid");
        assert_eq!(
            mcp_session_keep_alive_from_env(),
            Duration::from_secs(DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS)
        );
        std::env::remove_var("MCP_SESSION_KEEP_ALIVE_SECS");
    }

    #[tokio::test]
    async fn mcp_session_expires_after_inactivity() {
        let router =
            build_router_with_mcp_session_timeout(test_state().await, Duration::from_millis(25));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let url = format!("http://{address}/mcp");
        let client = reqwest::Client::new();

        let initialized = client
            .post(&url)
            .header("x-api-key", "test-key")
            .header("accept", "application/json, text/event-stream")
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": ClientInfo::default(),
            }))
            .send()
            .await
            .expect("initialize request should complete");
        assert!(initialized.status().is_success());
        let session_id = initialized
            .headers()
            .get("mcp-session-id")
            .expect("initialize should create a session")
            .to_str()
            .expect("session id should be valid")
            .to_owned();

        tokio::time::sleep(Duration::from_millis(100)).await;

        let resumed = client
            .post(&url)
            .header("x-api-key", "test-key")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-session-id", session_id)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "ping",
                "params": {},
            }))
            .send()
            .await
            .expect("resumed request should complete");

        assert_eq!(resumed.status(), reqwest::StatusCode::UNAUTHORIZED);
        server.abort();
    }
}
