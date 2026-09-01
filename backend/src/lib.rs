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
pub mod clockify;
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
    pub clockify: Option<clockify::ClockifyConfig>,
}

const DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS: u64 = 1800;
const DEFAULT_MCP_ALLOWED_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1"];

fn mcp_session_keep_alive_from_env() -> Duration {
    let seconds = std::env::var("MCP_SESSION_KEEP_ALIVE_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_MCP_SESSION_KEEP_ALIVE_SECS);
    Duration::from_secs(seconds)
}

fn mcp_allowed_hosts_from_env() -> Vec<String> {
    std::env::var("MCP_ALLOWED_HOSTS")
        .ok()
        .map(|hosts| {
            hosts
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .filter(|hosts: &Vec<String>| !hosts.is_empty())
        .unwrap_or_else(|| {
            DEFAULT_MCP_ALLOWED_HOSTS
                .iter()
                .map(|host| (*host).to_owned())
                .collect()
        })
}

pub fn build_router(state: AppState) -> Router {
    build_router_with_mcp_session_config(
        state,
        session_config_with_keep_alive(mcp_session_keep_alive_from_env()),
    )
}

fn session_config_with_keep_alive(keep_alive: Duration) -> SessionConfig {
    let mut session_config = SessionConfig::default();
    session_config.keep_alive = Some(keep_alive);
    session_config
}

fn build_router_with_mcp_session_config(state: AppState, session_config: SessionConfig) -> Router {
    let api = Router::new()
        .route(
            "/projects",
            get(handlers::projects::list_projects).post(handlers::projects::create_project),
        )
        .route(
            "/projects/{id}",
            get(handlers::projects::get_project)
                .patch(handlers::projects::update_project)
                .delete(handlers::projects::delete_project),
        )
        .route("/tasks", post(handlers::tasks::create_task))
        .route(
            "/tasks/{id}",
            get(handlers::tasks::get_task)
                .patch(handlers::tasks::update_task)
                .delete(handlers::tasks::delete_task),
        )
        .route(
            "/projects/{id}/tasks",
            get(handlers::tasks::list_project_tasks),
        )
        .route("/tasks/{id}/status", post(handlers::tasks::transition_task))
        .route(
            "/tasks/{id}/logs",
            get(handlers::tasks::list_logs).post(handlers::tasks::create_log),
        )
        .route("/tasks/{id}/tags", post(handlers::tasks::attach_tag))
        .route(
            "/tasks/{id}/tags/{tag_id}",
            delete(handlers::tasks::remove_tag),
        )
        .route("/tags", get(handlers::tags::list_tags))
        .route(
            "/tasks/needs-attention",
            get(handlers::tasks::list_attention),
        )
        .route(
            "/time-entries",
            get(handlers::time_entries::list_time_entries)
                .post(handlers::time_entries::create_time_entry),
        )
        .route(
            "/time-entries/sync",
            post(handlers::time_entries::sync_time_entries),
        )
        .route(
            "/time-entries/{id}",
            delete(handlers::time_entries::delete_time_entry)
                .patch(handlers::time_entries::update_time_entry),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn(error::normalize_api_errors))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    let mcp_pool = state.pool.clone();
    let mcp_events = state.events.clone();
    let mcp_clockify = state.clockify.clone();
    let mcp: Router<AppState> = Router::new()
        .nest_service(
            "/mcp",
            StreamableHttpService::new(
                move || {
                    Ok(mcp::TaskMcpServer::new(
                        mcp_pool.clone(),
                        mcp_events.clone(),
                        mcp_clockify.clone(),
                    ))
                },
                {
                    let mut session_manager = LocalSessionManager::default();
                    session_manager.session_config = session_config;
                    session_manager.into()
                },
                StreamableHttpServerConfig::default()
                    .with_allowed_hosts(mcp_allowed_hosts_from_env()),
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
    build_router_with_mcp_session_config(state, session_config_with_keep_alive(keep_alive))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use rmcp::model::ClientInfo;
    use tower::ServiceExt;

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
            clockify: None,
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
    async fn mcp_initialize_accepts_configured_production_host() {
        let state = test_state().await;

        let initialize_request = |host| {
            Request::builder()
                .method("POST")
                .uri("/mcp")
                .header("host", host)
                .header("x-api-key", "test-key")
                .header("accept", "application/json, text/event-stream")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": ClientInfo::default(),
                    })
                    .to_string(),
                ))
                .expect("initialize request should build")
        };

        let default_response = build_router(state.clone())
            .oneshot(initialize_request("tracker.home.kurbezz.me"))
            .await
            .expect("initialize request should complete");
        assert_eq!(default_response.status(), StatusCode::FORBIDDEN);

        std::env::set_var("MCP_ALLOWED_HOSTS", "tracker.home.kurbezz.me");
        let router = build_router(state);
        std::env::remove_var("MCP_ALLOWED_HOSTS");

        let rejected_response = router
            .clone()
            .oneshot(initialize_request("untrusted.example"))
            .await
            .expect("initialize request should complete");
        assert_eq!(rejected_response.status(), StatusCode::FORBIDDEN);

        let response = router
            .oneshot(initialize_request("tracker.home.kurbezz.me"))
            .await
            .expect("initialize request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("mcp-session-id"));
    }

    #[tokio::test]
    async fn mcp_session_expiry_returns_not_found_and_allows_reinitialization() {
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

        assert_eq!(resumed.status(), reqwest::StatusCode::NOT_FOUND);

        let reinitialized = client
            .post(&url)
            .header("x-api-key", "test-key")
            .header("accept", "application/json, text/event-stream")
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "initialize",
                "params": ClientInfo::default(),
            }))
            .send()
            .await
            .expect("replacement initialize request should complete");

        assert!(reinitialized.status().is_success());
        assert!(reinitialized.headers().contains_key("mcp-session-id"));
        server.abort();
    }
}
