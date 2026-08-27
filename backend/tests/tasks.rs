use axum::{
    http::{Method, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

mod support;

async fn create_project(app: &Router) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": "Tracker"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    support::json_body(response).await
}

async fn create_task(app: &Router, project_id: &str) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/tasks",
            Some(json!({
                "project_id": project_id,
                "title": "Implement API",
                "description": "Build the service",
                "agent": "coder"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    support::json_body(response).await
}

#[tokio::test]
async fn creates_lists_gets_and_updates_tasks_with_frontend_shape() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app).await;
    let project_id = project["id"].as_str().unwrap();
    let task = create_task(&app, project_id).await;
    let task_id = task["id"].as_str().unwrap();

    assert_eq!(task["project_id"], project_id);
    assert_eq!(task["status"], "TO_DO");
    assert_eq!(task["tags"], json!([]));
    assert_eq!(task["description"], "Build the service");
    assert_eq!(task["agent"], "coder");
    assert!(task["created_at"].as_str().is_some());
    assert!(task["updated_at"].as_str().is_some());

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/projects/{project_id}/tasks"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await, json!([task.clone()]));

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/tasks/{task_id}"),
            Some(json!({"agent": "reviewer", "result_summary": "Ready"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated = support::json_body(response).await;
    assert_eq!(updated["agent"], "reviewer");
    assert_eq!(updated["result_summary"], "Ready");
    assert_eq!(updated["status"], "TO_DO");
    assert_eq!(updated["tags"], json!([]));

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/tasks/{task_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await, updated);
}

#[tokio::test]
async fn validates_task_creation_and_missing_resources() {
    let app = ai_task_tracker::build_router(support::state().await);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/tasks",
            Some(json!({"project_id": "missing", "title": "Task"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let project = create_project(&app).await;
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/tasks",
            Some(json!({"project_id": project["id"], "title": " "})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            "/api/tasks/missing",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deletes_tasks_and_cascades_logs_and_tags() {
    let state = support::state().await;
    let pool = state.pool.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app).await;
    let task = create_task(&app, project["id"].as_str().unwrap()).await;
    let task_id = task["id"].as_str().unwrap().to_owned();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/tags"),
            Some(json!({"name": "cascade-test"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/logs"),
            Some(json!({"author": "test", "message": "Delete me"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::DELETE,
            &format!("/api/tasks/{task_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/tasks/{task_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(&task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 0);
    let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_tags WHERE task_id = ?")
        .bind(&task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tags, 0);
}

#[tokio::test]
async fn deleting_a_missing_task_returns_not_found() {
    let app = ai_task_tracker::build_router(support::state().await);

    let response = app
        .oneshot(support::api_request(
            Method::DELETE,
            "/api/tasks/missing",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn transitions_tasks_and_records_system_logs() {
    let state = support::state().await;
    let pool = state.pool.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app).await;
    let task = create_task(&app, project["id"].as_str().unwrap()).await;
    let task_id = task["id"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/status"),
            Some(json!({"status": "TO_REVIEW"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        support::json_body(response).await["code"],
        "INVALID_TRANSITION"
    );

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/status"),
            Some(json!({"status": "TO_AGENT"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await["status"], "TO_AGENT");

    let message: String = sqlx::query_scalar("SELECT message FROM task_logs WHERE task_id = ?")
        .bind(task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(message, "Status changed from TO_DO to TO_AGENT");

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/status"),
            Some(json!({"status": "TO_DO"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(support::api_request(
            Method::POST,
            "/api/tasks/missing/status",
            Some(json!({"status": "TO_AGENT"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn task_patch_distinguishes_omitted_and_null_optional_fields() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app).await;
    let task = create_task(&app, project["id"].as_str().unwrap()).await;
    let task_id = task["id"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/tasks/{task_id}"),
            Some(json!({"title": "Renamed"})),
        ))
        .await
        .unwrap();
    let preserved = support::json_body(response).await;
    assert_eq!(preserved["description"], "Build the service");
    assert_eq!(preserved["agent"], "coder");
    assert_eq!(preserved["result_summary"], json!(null));

    let response = app
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/tasks/{task_id}"),
            Some(json!({"description": null, "agent": null, "result_summary": null})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cleared = support::json_body(response).await;
    assert_eq!(cleared["description"], json!(null));
    assert_eq!(cleared["agent"], json!(null));
    assert_eq!(cleared["result_summary"], json!(null));
}

#[tokio::test]
async fn duplicate_transitions_do_not_create_extra_status_logs() {
    let (state, database_path) = support::file_state().await;
    let pool = state.pool.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app).await;
    let task = create_task(&app, project["id"].as_str().unwrap()).await;
    let task_id = task["id"].as_str().unwrap().to_owned();

    let mut write_lock = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *write_lock)
        .await
        .unwrap();

    let first_app = app.clone();
    let first_task_id = task_id.clone();
    let first = tokio::spawn(async move {
        first_app
            .oneshot(support::api_request(
                Method::POST,
                &format!("/api/tasks/{first_task_id}/status"),
                Some(json!({"status": "TO_AGENT"})),
            ))
            .await
            .unwrap()
    });
    let second_app = app.clone();
    let second_task_id = task_id.clone();
    let second = tokio::spawn(async move {
        second_app
            .oneshot(support::api_request(
                Method::POST,
                &format!("/api/tasks/{second_task_id}/status"),
                Some(json!({"status": "TO_AGENT"})),
            ))
            .await
            .unwrap()
    });
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    sqlx::query("COMMIT")
        .execute(&mut *write_lock)
        .await
        .unwrap();
    drop(write_lock);

    let statuses = [
        first.await.unwrap().status(),
        second.await.unwrap().status(),
    ];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(&task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 1);
    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(&task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "TO_AGENT");

    drop(app);
    pool.close().await;
    std::fs::remove_file(database_path).unwrap();
}
