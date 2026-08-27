use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{CreateProject, Project, UpdateProject},
    AppState,
};

pub async fn list_projects(State(state): State<AppState>) -> Result<Json<Vec<Project>>, AppError> {
    Ok(Json(list_projects_core(&state).await?))
}

pub(crate) async fn list_projects_core(state: &AppState) -> Result<Vec<Project>, AppError> {
    let projects = sqlx::query_as::<_, Project>(
        "SELECT id, name, description, created_at FROM projects ORDER BY created_at",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(projects)
}

pub async fn create_project(
    State(state): State<AppState>,
    Json(input): Json<CreateProject>,
) -> Result<impl IntoResponse, AppError> {
    validate_name(&input.name)?;

    let project = Project {
        id: Uuid::new_v4().to_string(),
        name: input.name,
        description: input.description,
        created_at: Utc::now().to_rfc3339(),
    };
    sqlx::query("INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)")
        .bind(&project.id)
        .bind(&project.name)
        .bind(&project.description)
        .bind(&project.created_at)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;

    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Project>, AppError> {
    Ok(Json(fetch_project(&state, &id).await?))
}

pub async fn update_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateProject>,
) -> Result<Json<Project>, AppError> {
    let project = fetch_project(&state, &id).await?;
    let name = input.name.unwrap_or(project.name);
    validate_name(&name)?;
    let description = input.description.resolve(project.description);

    sqlx::query("UPDATE projects SET name = ?, description = ? WHERE id = ?")
        .bind(name)
        .bind(description)
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;

    Ok(Json(fetch_project(&state, &id).await?))
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn fetch_project(state: &AppState, id: &str) -> Result<Project, AppError> {
    sqlx::query_as::<_, Project>(
        "SELECT id, name, description, created_at FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::Internal)?
    .ok_or(AppError::NotFound)
}

fn validate_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("project name is required".to_owned()));
    }
    Ok(())
}
