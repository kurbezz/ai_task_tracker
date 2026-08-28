use axum::{http::Method, http::StatusCode, Router};
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

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

async fn create_task(app: &Router, project_id: &str, title: &str) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/tasks",
            Some(json!({"project_id": project_id, "title": title})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    support::json_body(response).await
}

async fn create_time_entry(app: &Router, task_id: &str, minutes: i64) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/time-entries",
            Some(json!({
                "task_id": task_id,
                "entry_date": "2026-08-28",
                "minutes": minutes
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    support::json_body(response).await
}

#[tokio::test]
async fn time_entries_support_create_list_update_and_delete() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app).await;
    let first_task = create_task(&app, project["id"].as_str().unwrap(), "First task").await;
    let second_task = create_task(&app, project["id"].as_str().unwrap(), "Second task").await;

    let entry = create_time_entry(&app, first_task["id"].as_str().unwrap(), 90).await;
    assert_eq!(entry["task_title"], "First task");
    assert_eq!(entry["minutes"], 90);
    let entry_id = entry["id"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::GET,
            "/api/time-entries?date=2026-08-28",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let listed = support::json_body(response).await;
    assert_eq!(listed["entries"], json!([entry.clone()]));
    assert_eq!(listed["sync"]["is_synced"], false);
    assert_eq!(listed["sync"]["synced_at"], json!(null));

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/time-entries/{entry_id}"),
            Some(json!({
                "task_id": second_task["id"],
                "minutes": 45
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated = support::json_body(response).await;
    assert_eq!(updated["task_id"], second_task["id"]);
    assert_eq!(updated["task_title"], "Second task");
    assert_eq!(updated["minutes"], 45);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::DELETE,
            &format!("/api/time-entries/{entry_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            "/api/time-entries?date=2026-08-28",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await["entries"], json!([]));
}

#[tokio::test]
async fn sync_posts_then_puts_the_same_clockify_entry() {
    let mock_server = MockServer::start().await;
    std::env::set_var("CLOCKIFY_API_KEY", "clockify-key");
    std::env::set_var("CLOCKIFY_WORKSPACE_ID", "workspace-1");
    std::env::set_var("CLOCKIFY_BASE_URL", mock_server.uri());
    let mut state = support::state().await;
    state.clockify = ai_task_tracker::clockify::ClockifyConfig::from_env();
    std::env::remove_var("CLOCKIFY_API_KEY");
    std::env::remove_var("CLOCKIFY_WORKSPACE_ID");
    std::env::remove_var("CLOCKIFY_BASE_URL");
    let pool = state.pool.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app).await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Tracked task").await;

    Mock::given(method("POST"))
        .and(path("/workspaces/workspace-1/time-entries"))
        .and(header("x-api-key", "clockify-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "clockify-entry-1"})))
        .expect(1)
        .mount(&mock_server)
        .await;
    Mock::given(method("PUT"))
        .and(path(
            "/workspaces/workspace-1/time-entries/clockify-entry-1",
        ))
        .and(header("x-api-key", "clockify-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "clockify-entry-1"})))
        .expect(1)
        .mount(&mock_server)
        .await;

    create_time_entry(&app, task["id"].as_str().unwrap(), 60).await;
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/time-entries/sync",
            Some(json!({"entry_date": "2026-08-28"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await["is_synced"], true);

    let clockify_entry_id: String =
        sqlx::query_scalar("SELECT clockify_entry_id FROM daily_time_syncs WHERE entry_date = ?")
            .bind("2026-08-28")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(clockify_entry_id, "clockify-entry-1");

    create_time_entry(&app, task["id"].as_str().unwrap(), 30).await;
    let response = app
        .oneshot(support::api_request(
            Method::POST,
            "/api/time-entries/sync",
            Some(json!({"entry_date": "2026-08-28"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    mock_server.verify().await;
}
