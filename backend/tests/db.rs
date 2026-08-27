use ai_task_tracker::db;

#[tokio::test]
async fn connect_creates_and_migrates_a_nonexistent_sqlite_file() {
    let path = std::env::temp_dir().join(format!("ai-task-tracker-{}.db", uuid::Uuid::new_v4()));
    assert!(!path.exists());
    let database_url = format!("sqlite:{}", path.display());

    let pool = db::connect(&database_url).await.unwrap();
    db::migrate(&pool).await.unwrap();

    assert!(path.is_file());
    let table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(table.as_deref(), Some("projects"));

    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
