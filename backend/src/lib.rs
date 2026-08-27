use axum::{
    http::StatusCode,
    middleware,
    routing::{delete, get, post},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

pub mod auth;
pub mod db;
pub mod error;
pub mod handlers;
pub mod mcp;
pub mod models;
pub mod static_files;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
}

pub fn build_router(state: AppState) -> Router {
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
            get(handlers::tasks::get_task).patch(handlers::tasks::update_task),
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
    let mcp: Router<AppState> = Router::new()
        .nest_service(
            "/mcp",
            StreamableHttpService::new(
                move || Ok(mcp::TaskMcpServer::new(mcp_pool.clone())),
                LocalSessionManager::default().into(),
                StreamableHttpServerConfig::default(),
            ),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/api", api)
        .merge(mcp)
        .fallback(static_files::serve)
        .with_state(state)
}
