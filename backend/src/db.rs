use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::{path::Path, str::FromStr, time::Duration};

use crate::auth::hash_key;

pub async fn connect(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    if let Some(path) = database_url.strip_prefix("sqlite:") {
        if path != ":memory:" {
            if let Some(parent) = Path::new(path).parent() {
                std::fs::create_dir_all(parent).ok();
            }
        }
    }

    let max_connections = if database_url == "sqlite::memory:" {
        1
    } else {
        5
    };
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5));
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

pub async fn ensure_initial_api_key(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys")
        .fetch_one(pool)
        .await?;

    if count == 0 {
        use rand::RngCore;

        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let key = hex::encode(bytes);

        sqlx::query("INSERT INTO api_keys (id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(hash_key(&key))
            .bind("initial")
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(pool)
            .await?;

        println!("Initial API key (save it now): {key}");
    }

    Ok(())
}
