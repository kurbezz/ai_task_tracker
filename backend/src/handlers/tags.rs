use axum::{extract::State, Json};

use crate::{error::AppError, models::Tag, AppState};

pub async fn list_tags(State(state): State<AppState>) -> Result<Json<Vec<Tag>>, AppError> {
    let tags = sqlx::query_as::<_, Tag>("SELECT id, name, is_system FROM tags ORDER BY name")
        .fetch_all(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(tags))
}
