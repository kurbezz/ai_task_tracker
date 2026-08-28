use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    clockify::{self, TimeEntryDescriptionRow},
    error::AppError,
    AppState,
};

#[derive(Deserialize)]
pub struct ListTimeEntriesQuery {
    pub date: String,
}

#[derive(Deserialize)]
pub struct CreateTimeEntry {
    pub task_id: String,
    pub entry_date: String,
    pub minutes: i64,
}

#[derive(Deserialize)]
pub struct UpdateTimeEntry {
    pub task_id: Option<String>,
    pub minutes: Option<i64>,
}

#[derive(Deserialize)]
pub struct SyncTimeEntries {
    pub entry_date: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TimeEntryResponse {
    pub id: String,
    pub task_id: String,
    pub task_title: String,
    pub minutes: i64,
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub synced_at: Option<String>,
    pub is_synced: bool,
    pub clockify_entry_id: Option<String>,
}

#[derive(Serialize)]
pub struct ListTimeEntriesResponse {
    pub entries: Vec<TimeEntryResponse>,
    pub sync: SyncStatus,
}

pub async fn list_time_entries(
    State(state): State<AppState>,
    Query(ListTimeEntriesQuery { date }): Query<ListTimeEntriesQuery>,
) -> Result<Json<ListTimeEntriesResponse>, AppError> {
    validate_entry_date(&date)?;
    let entries = list_entries_for_date(&state, &date).await?;
    let sync = fetch_sync_status(&state, &date).await?;

    Ok(Json(ListTimeEntriesResponse { entries, sync }))
}

pub async fn create_time_entry(
    State(state): State<AppState>,
    Json(input): Json<CreateTimeEntry>,
) -> Result<(StatusCode, Json<TimeEntryResponse>), AppError> {
    validate_entry_date(&input.entry_date)?;
    validate_minutes(input.minutes)?;
    ensure_task_exists(&state, &input.task_id).await?;

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO time_entries (id, task_id, entry_date, minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.task_id)
    .bind(&input.entry_date)
    .bind(input.minutes)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok((StatusCode::CREATED, Json(fetch_entry(&state, &id).await?)))
}

pub async fn update_time_entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateTimeEntry>,
) -> Result<Json<TimeEntryResponse>, AppError> {
    let entry = fetch_entry(&state, &id).await?;
    let task_id = input.task_id.unwrap_or(entry.task_id);
    let minutes = input.minutes.unwrap_or(entry.minutes);
    validate_minutes(minutes)?;
    ensure_task_exists(&state, &task_id).await?;

    sqlx::query("UPDATE time_entries SET task_id = ?, minutes = ?, updated_at = ? WHERE id = ?")
        .bind(task_id)
        .bind(minutes)
        .bind(Utc::now().to_rfc3339())
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;

    Ok(Json(fetch_entry(&state, &id).await?))
}

pub async fn delete_time_entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM time_entries WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn sync_time_entries(
    State(state): State<AppState>,
    Json(SyncTimeEntries { entry_date }): Json<SyncTimeEntries>,
) -> Result<Json<SyncStatus>, AppError> {
    validate_entry_date(&entry_date)?;
    let Some(config) = state.clockify.clone() else {
        return Err(AppError::BadRequest(
            "Clockify is not configured".to_owned(),
        ));
    };
    let entries = sqlx::query_as::<_, TimeEntryDescriptionRow>(
        "SELECT tasks.title AS task_title, time_entries.minutes \
         FROM time_entries INNER JOIN tasks ON tasks.id = time_entries.task_id \
         WHERE time_entries.entry_date = ? ORDER BY time_entries.created_at, time_entries.id",
    )
    .bind(&entry_date)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;
    let request =
        clockify::build_time_entry_request(&entry_date, &entries, config.project_id.clone())
            .map_err(AppError::Validation)?;
    let existing_sync = fetch_daily_sync(&state, &entry_date).await?;
    let clockify_entry_id = match existing_sync.and_then(|sync| sync.clockify_entry_id) {
        Some(id) => {
            clockify::update_time_entry(&config, &id, &request)
                .await
                .map_err(clockify_error)?;
            id
        }
        None => clockify::create_time_entry(&config, &request)
            .await
            .map_err(clockify_error)?,
    };
    let synced_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO daily_time_syncs (entry_date, clockify_entry_id, synced_at) VALUES (?, ?, ?) \
         ON CONFLICT(entry_date) DO UPDATE SET clockify_entry_id = excluded.clockify_entry_id, synced_at = excluded.synced_at",
    )
    .bind(&entry_date)
    .bind(&clockify_entry_id)
    .bind(&synced_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(Json(SyncStatus {
        synced_at: Some(synced_at),
        is_synced: true,
        clockify_entry_id: Some(clockify_entry_id),
    }))
}

async fn list_entries_for_date(
    state: &AppState,
    entry_date: &str,
) -> Result<Vec<TimeEntryResponse>, AppError> {
    sqlx::query_as::<_, TimeEntryResponse>(
        "SELECT time_entries.id, time_entries.task_id, tasks.title AS task_title, time_entries.minutes \
         FROM time_entries INNER JOIN tasks ON tasks.id = time_entries.task_id \
         WHERE time_entries.entry_date = ? ORDER BY time_entries.created_at, time_entries.id",
    )
    .bind(entry_date)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)
}

async fn fetch_entry(state: &AppState, id: &str) -> Result<TimeEntryResponse, AppError> {
    sqlx::query_as::<_, TimeEntryResponse>(
        "SELECT time_entries.id, time_entries.task_id, tasks.title AS task_title, time_entries.minutes \
         FROM time_entries INNER JOIN tasks ON tasks.id = time_entries.task_id \
         WHERE time_entries.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::Internal)?
    .ok_or(AppError::NotFound)
}

#[derive(sqlx::FromRow)]
struct DailyTimeSync {
    clockify_entry_id: Option<String>,
    synced_at: Option<String>,
}

async fn fetch_daily_sync(
    state: &AppState,
    entry_date: &str,
) -> Result<Option<DailyTimeSync>, AppError> {
    sqlx::query_as::<_, DailyTimeSync>(
        "SELECT clockify_entry_id, synced_at FROM daily_time_syncs WHERE entry_date = ?",
    )
    .bind(entry_date)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::Internal)
}

async fn fetch_sync_status(state: &AppState, entry_date: &str) -> Result<SyncStatus, AppError> {
    let sync = fetch_daily_sync(state, entry_date).await?;
    let clockify_entry_id = sync
        .as_ref()
        .and_then(|sync| sync.clockify_entry_id.clone());
    Ok(SyncStatus {
        synced_at: sync.as_ref().and_then(|sync| sync.synced_at.clone()),
        is_synced: clockify_entry_id.is_some(),
        clockify_entry_id,
    })
}

async fn ensure_task_exists(state: &AppState, task_id: &str) -> Result<(), AppError> {
    let exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(AppError::Internal)?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

fn validate_entry_date(entry_date: &str) -> Result<(), AppError> {
    NaiveDate::parse_from_str(entry_date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| AppError::Validation("entry_date must be YYYY-MM-DD".to_owned()))
}

fn validate_minutes(minutes: i64) -> Result<(), AppError> {
    if minutes > 0 {
        Ok(())
    } else {
        Err(AppError::Validation(
            "minutes must be greater than zero".to_owned(),
        ))
    }
}

fn clockify_error(error: clockify::ClockifyError) -> AppError {
    let status = error
        .status
        .and_then(|status| axum::http::StatusCode::from_u16(status.as_u16()).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    AppError::External {
        status,
        message: error.message,
    }
}
