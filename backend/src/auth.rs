use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use sha2::{Digest, Sha256};

use crate::{error::AppError, AppState};

pub fn hash_key(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub async fn require_api_key(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let Some(value) = request
        .headers()
        .get(header::HeaderName::from_static("x-api-key"))
    else {
        return Err(AppError::Unauthorized);
    };
    let Ok(value) = value.to_str() else {
        return Err(AppError::Unauthorized);
    };

    let key_exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM api_keys WHERE key_hash = ?")
        .bind(hash_key(value))
        .fetch_optional(&state.pool)
        .await
        .map_err(AppError::Internal)?
        .is_some();

    if !key_exists {
        return Err(AppError::Unauthorized);
    }

    Ok(next.run(request).await)
}
