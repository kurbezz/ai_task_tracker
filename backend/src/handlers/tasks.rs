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
    models::{
        AttachTag, AttentionItem, CreateLog, CreateTask, Status, Tag, Task, TaskLog, TaskResponse,
        TransitionRequest, UpdateTask,
    },
    AppState,
};

pub async fn create_task(
    State(state): State<AppState>,
    Json(input): Json<CreateTask>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::CREATED,
        Json(create_task_core(&state, input).await?),
    ))
}

pub(crate) async fn create_task_core(
    state: &AppState,
    input: CreateTask,
) -> Result<TaskResponse, AppError> {
    ensure_project(state, &input.project_id).await?;
    validate_title(&input.title)?;

    let now = Utc::now().to_rfc3339();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: input.project_id,
        title: input.title,
        description: input.description,
        status: Status::Todo.to_string(),
        agent: input.agent,
        result_summary: None,
        created_at: now.clone(),
        updated_at: now,
    };
    sqlx::query(
        "INSERT INTO tasks (id, project_id, title, description, status, agent, result_summary, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&task.id)
    .bind(&task.project_id)
    .bind(&task.title)
    .bind(&task.description)
    .bind(&task.status)
    .bind(&task.agent)
    .bind(&task.result_summary)
    .bind(&task.created_at)
    .bind(&task.updated_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    task_response(state, task).await
}

pub async fn get_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TaskResponse>, AppError> {
    Ok(Json(
        task_response(&state, fetch_task(&state, &id).await?).await?,
    ))
}

pub async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateTask>,
) -> Result<Json<TaskResponse>, AppError> {
    let task = fetch_task(&state, &id).await?;
    let title = input.title.unwrap_or(task.title);
    validate_title(&title)?;
    let description = input.description.resolve(task.description);
    let agent = input.agent.resolve(task.agent);
    let result_summary = input.result_summary.resolve(task.result_summary);

    sqlx::query(
        "UPDATE tasks SET title = ?, description = ?, agent = ?, result_summary = ?, updated_at = ? WHERE id = ?",
    )
    .bind(title)
    .bind(description)
    .bind(agent)
    .bind(result_summary)
    .bind(Utc::now().to_rfc3339())
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(Json(
        task_response(&state, fetch_task(&state, &id).await?).await?,
    ))
}

pub async fn list_project_tasks(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TaskResponse>>, AppError> {
    ensure_project(&state, &project_id).await?;
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT id, project_id, title, description, status, agent, result_summary, created_at, updated_at \
         FROM tasks WHERE project_id = ? ORDER BY created_at",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    let mut responses = Vec::with_capacity(tasks.len());
    for task in tasks {
        responses.push(task_response(&state, task).await?);
    }
    Ok(Json(responses))
}

pub async fn transition_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<TransitionRequest>,
) -> Result<Json<TaskResponse>, AppError> {
    let mut connection = state.pool.acquire().await.map_err(AppError::Internal)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;

    let result = async {
        let task = sqlx::query_as::<_, Task>(
            "SELECT id, project_id, title, description, status, agent, result_summary, created_at, updated_at \
             FROM tasks WHERE id = ?",
        )
        .bind(&id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(AppError::Internal)?
        .ok_or(AppError::NotFound)?;
        let current: Status = task
            .status
            .parse()
            .expect("database task statuses must be valid");
        if !current.can_transition_to(input.status) {
            return Err(AppError::InvalidTransition(format!(
                "cannot transition from {current} to {}",
                input.status
            )));
        }

        let now = Utc::now().to_rfc3339();
        let updated = sqlx::query(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
        )
        .bind(input.status.to_string())
        .bind(&now)
        .bind(&id)
        .bind(current.to_string())
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;
        if updated.rows_affected() == 0 {
            return Err(AppError::InvalidTransition(format!(
                "cannot transition from {current} to {}",
                input.status
            )));
        }
        sqlx::query(
            "INSERT INTO task_logs (id, task_id, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&id)
        .bind("system")
        .bind(format!("Status changed from {current} to {}", input.status))
        .bind(now)
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(AppError::Internal)?;
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(error);
        }
    }
    drop(connection);

    Ok(Json(
        task_response(&state, fetch_task(&state, &id).await?).await?,
    ))
}

pub async fn list_logs(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<Vec<TaskLog>>, AppError> {
    fetch_task(&state, &task_id).await?;
    let logs = sqlx::query_as::<_, TaskLog>(
        "SELECT id, task_id, author, message, created_at FROM task_logs \
         WHERE task_id = ? ORDER BY created_at, id",
    )
    .bind(task_id)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;
    Ok(Json(logs))
}

pub async fn create_log(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(input): Json<CreateLog>,
) -> Result<impl IntoResponse, AppError> {
    fetch_task(&state, &task_id).await?;
    validate_log(&input.author, &input.message)?;

    let log = TaskLog {
        id: Uuid::new_v4().to_string(),
        task_id,
        author: input.author,
        message: input.message,
        created_at: Utc::now().to_rfc3339(),
    };
    sqlx::query(
        "INSERT INTO task_logs (id, task_id, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&log.id)
    .bind(&log.task_id)
    .bind(&log.author)
    .bind(&log.message)
    .bind(&log.created_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok((StatusCode::CREATED, Json(log)))
}

pub async fn attach_tag(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(input): Json<AttachTag>,
) -> Result<Json<TaskResponse>, AppError> {
    fetch_task(&state, &task_id).await?;
    validate_tag_name(&input.name)?;

    sqlx::query(
        "INSERT INTO tags (id, name, is_system) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&input.name)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;
    let tag: Tag = sqlx::query_as("SELECT id, name, is_system FROM tags WHERE name = ?")
        .bind(&input.name)
        .fetch_one(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    sqlx::query(
        "INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?) ON CONFLICT(task_id, tag_id) DO NOTHING",
    )
    .bind(&task_id)
    .bind(&tag.id)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(Json(
        task_response(&state, fetch_task(&state, &task_id).await?).await?,
    ))
}

pub async fn remove_tag(
    State(state): State<AppState>,
    Path((task_id, tag_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    fetch_task(&state, &task_id).await?;
    sqlx::query("DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?")
        .bind(task_id)
        .bind(tag_id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_attention(
    State(state): State<AppState>,
) -> Result<Json<Vec<AttentionItem>>, AppError> {
    let rows = sqlx::query_as::<_, AttentionTask>(
        "SELECT DISTINCT tasks.id, tasks.project_id, tasks.title, tasks.description, tasks.status, \
         tasks.agent, tasks.result_summary, tasks.created_at, tasks.updated_at, projects.name AS project_name \
         FROM tasks \
         INNER JOIN projects ON projects.id = tasks.project_id \
         INNER JOIN task_tags ON task_tags.task_id = tasks.id \
         INNER JOIN tags ON tags.id = task_tags.tag_id \
         WHERE tags.name IN ('NEEDS_USER_INPUT', 'BLOCKED', 'FAILED') \
         ORDER BY tasks.updated_at",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    let mut attention = Vec::with_capacity(rows.len());
    for row in rows {
        let task = Task {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            description: row.description,
            status: row.status,
            agent: row.agent,
            result_summary: row.result_summary,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
        attention.push(AttentionItem {
            task: task_response(&state, task).await?,
            project_name: row.project_name,
        });
    }
    Ok(Json(attention))
}

pub(crate) async fn fetch_task(state: &AppState, id: &str) -> Result<Task, AppError> {
    sqlx::query_as::<_, Task>(
        "SELECT id, project_id, title, description, status, agent, result_summary, created_at, updated_at \
         FROM tasks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::Internal)?
    .ok_or(AppError::NotFound)
}

pub(crate) async fn task_response(state: &AppState, task: Task) -> Result<TaskResponse, AppError> {
    let tags = sqlx::query_as::<_, Tag>(
        "SELECT tags.id, tags.name, tags.is_system FROM tags \
         INNER JOIN task_tags ON task_tags.tag_id = tags.id \
         WHERE task_tags.task_id = ? ORDER BY tags.name",
    )
    .bind(&task.id)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(TaskResponse::new(task, tags))
}

async fn ensure_project(state: &AppState, id: &str) -> Result<(), AppError> {
    let exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM projects WHERE id = ?")
        .bind(id)
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

fn validate_title(title: &str) -> Result<(), AppError> {
    if title.trim().is_empty() {
        return Err(AppError::Validation("task title is required".to_owned()));
    }
    Ok(())
}

fn validate_log(author: &str, message: &str) -> Result<(), AppError> {
    if author.trim().is_empty() || message.trim().is_empty() {
        return Err(AppError::Validation(
            "log author and message are required".to_owned(),
        ));
    }
    Ok(())
}

fn validate_tag_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("tag name is required".to_owned()));
    }

    const SYSTEM_TAGS: [&str; 3] = ["NEEDS_USER_INPUT", "BLOCKED", "FAILED"];
    if let Some(system_tag) = SYSTEM_TAGS
        .iter()
        .find(|system_tag| name.eq_ignore_ascii_case(system_tag))
    {
        if name != *system_tag {
            return Err(AppError::Validation(format!(
                "use the canonical system tag name: {system_tag}"
            )));
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct AttentionTask {
    id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    status: String,
    agent: Option<String>,
    result_summary: Option<String>,
    created_at: String,
    updated_at: String,
    project_name: String,
}
