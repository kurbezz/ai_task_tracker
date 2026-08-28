use ai_task_tracker::{
    build_router,
    db::{connect, ensure_initial_api_key, migrate},
    AppState,
};

#[tokio::main]
async fn main() {
    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:data/tracker.db".to_owned());
    let pool = connect(&database_url).await.unwrap();
    migrate(&pool).await.unwrap();
    ensure_initial_api_key(&pool).await.unwrap();
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    axum::serve(
        listener,
        build_router(AppState {
            pool,
            events: tokio::sync::broadcast::channel(256).0,
        }),
    )
    .await
    .unwrap();
}
