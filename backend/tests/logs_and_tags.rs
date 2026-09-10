use ai_task_tracker::events::TaskEvent;
use axum::{
    http::{HeaderValue, Method, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

mod support;

async fn create_project(app: &Router, name: &str) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": name})),
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

async fn attach_tag(app: &Router, task_id: &str, name: &str) -> Value {
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/tags"),
            Some(json!({"name": name})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    support::json_body(response).await
}

#[tokio::test]
async fn creates_lists_and_validates_task_logs() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap();

    for (author, message) in [("coder", "Started"), ("reviewer", "Reviewed")] {
        let response = app
            .clone()
            .oneshot(support::api_request(
                Method::POST,
                &format!("/api/tasks/{task_id}/logs"),
                Some(json!({"author": author, "message": message})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let log = support::json_body(response).await;
        assert_eq!(log["task_id"], task_id);
        assert_eq!(log["author"], author);
        assert_eq!(log["message"], message);
        assert!(log["id"].as_str().is_some());
        assert!(log["created_at"].as_str().is_some());
    }

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/tasks/{task_id}/logs"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let logs = support::json_body(response).await;
    assert_eq!(logs[0]["message"], "Started");
    assert_eq!(logs[1]["message"], "Reviewed");

    for body in [
        json!({"author": "", "message": "message"}),
        json!({"author": "author", "message": " "}),
    ] {
        let response = app
            .clone()
            .oneshot(support::api_request(
                Method::POST,
                &format!("/api/tasks/{task_id}/logs"),
                Some(body),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn idempotent_log_requests_replay_the_original_log_without_another_event() {
    let state = support::state().await;
    let pool = state.pool.clone();
    let events = state.events.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap();
    let mut log_events = events.subscribe();
    let body = json!({"author": "coder", "message": "Started"});

    let response = app
        .clone()
        .oneshot(support::api_request_with_idempotency_key(
            Method::POST,
            &format!("/api/tasks/{task_id}/logs"),
            Some(body.clone()),
            "log-request-1",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let first_log = support::json_body(response).await;
    match log_events.recv().await.unwrap() {
        TaskEvent::LogAdded {
            task_id: event_task_id,
            log,
        } => {
            assert_eq!(event_task_id, task_id);
            assert_eq!(log.id, first_log["id"].as_str().unwrap());
        }
        _ => panic!("expected a log-added event"),
    }

    let response = app
        .clone()
        .oneshot(support::api_request_with_idempotency_key(
            Method::POST,
            &format!("/api/tasks/{task_id}/logs"),
            Some(body.clone()),
            "log-request-1",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await, first_log);
    assert!(matches!(log_events.try_recv(), Err(TryRecvError::Empty)));

    let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 1);

    let response = app
        .oneshot(support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/logs"),
            Some(body),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let _ = log_events.recv().await.unwrap();
}

#[tokio::test]
async fn rejects_invalid_idempotency_keys_without_creating_logs_or_events() {
    let state = support::state().await;
    let pool = state.pool.clone();
    let events = state.events.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap();
    let mut log_events = events.subscribe();
    let body = json!({"author": "coder", "message": "Started"});

    for header_value in [
        HeaderValue::from_static(""),
        HeaderValue::from_static(" \t "),
    ] {
        let mut request = support::api_request(
            Method::POST,
            &format!("/api/tasks/{task_id}/logs"),
            Some(body.clone()),
        );
        request
            .headers_mut()
            .insert("idempotency-key", header_value);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    let mut request = support::api_request(
        Method::POST,
        &format!("/api/tasks/{task_id}/logs"),
        Some(body.clone()),
    );
    request
        .headers_mut()
        .insert("idempotency-key", HeaderValue::from_bytes(b"\xff").unwrap());
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let mut request = support::api_request(
        Method::POST,
        &format!("/api/tasks/{task_id}/logs"),
        Some(body),
    );
    request
        .headers_mut()
        .append("idempotency-key", HeaderValue::from_static("first"));
    request
        .headers_mut()
        .append("idempotency-key", HeaderValue::from_static("second"));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 0);
    assert!(matches!(log_events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn idempotency_keys_are_global_and_cannot_replay_logs_across_tasks() {
    let state = support::state().await;
    let pool = state.pool.clone();
    let events = state.events.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app, "Tracker").await;
    let project_id = project["id"].as_str().unwrap();
    let first_task = create_task(&app, project_id, "First task").await;
    let second_task = create_task(&app, project_id, "Second task").await;
    let first_task_id = first_task["id"].as_str().unwrap();
    let second_task_id = second_task["id"].as_str().unwrap();
    let mut log_events = events.subscribe();
    let key = "globally-unique-log-request";

    let response = app
        .clone()
        .oneshot(support::api_request_with_idempotency_key(
            Method::POST,
            &format!("/api/tasks/{first_task_id}/logs"),
            Some(json!({"author": "coder", "message": "First"})),
            key,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let first_log = support::json_body(response).await;
    let event = log_events.recv().await.unwrap();
    assert!(matches!(event, TaskEvent::LogAdded { .. }));

    let response = app
        .oneshot(support::api_request_with_idempotency_key(
            Method::POST,
            &format!("/api/tasks/{second_task_id}/logs"),
            Some(json!({"author": "coder", "message": "Second"})),
            key,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error = support::json_body(response).await;
    assert_ne!(error, first_log);
    assert!(error.get("id").is_none());
    assert!(matches!(log_events.try_recv(), Err(TryRecvError::Empty)));

    let first_logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(first_task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let second_logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(second_task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(first_logs, 1);
    assert_eq!(second_logs, 0);
}

#[tokio::test]
async fn concurrent_idempotent_log_requests_create_one_log_and_event() {
    let (state, database_path) = support::file_state().await;
    let pool = state.pool.clone();
    let events = state.events.clone();
    let app = ai_task_tracker::build_router(state);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap().to_owned();
    let mut log_events = events.subscribe();
    let body = json!({"author": "coder", "message": "Started"});

    let (first, second) = tokio::join!(
        app.clone()
            .oneshot(support::api_request_with_idempotency_key(
                Method::POST,
                &format!("/api/tasks/{task_id}/logs"),
                Some(body.clone()),
                "concurrent-log-request",
            )),
        app.clone()
            .oneshot(support::api_request_with_idempotency_key(
                Method::POST,
                &format!("/api/tasks/{task_id}/logs"),
                Some(body),
                "concurrent-log-request",
            )),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    let statuses = [first.status(), second.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    let first_log = support::json_body(first).await;
    let second_log = support::json_body(second).await;
    assert_eq!(first_log["id"], second_log["id"]);
    assert_eq!(first_log["task_id"], task_id);
    assert_eq!(first_log["task_id"], second_log["task_id"]);
    assert_eq!(first_log["author"], "coder");
    assert_eq!(first_log["author"], second_log["author"]);
    assert_eq!(first_log["message"], "Started");
    assert_eq!(first_log["message"], second_log["message"]);
    match log_events.recv().await.unwrap() {
        TaskEvent::LogAdded {
            task_id: event_task_id,
            log,
        } => {
            assert_eq!(event_task_id, task_id);
            assert_eq!(log.id, first_log["id"].as_str().unwrap());
        }
        _ => panic!("expected a log-added event"),
    }
    assert!(matches!(log_events.try_recv(), Err(TryRecvError::Empty)));

    let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_logs WHERE task_id = ?")
        .bind(&task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 1);

    drop(app);
    pool.close().await;
    std::fs::remove_file(database_path).unwrap();
}

#[tokio::test]
async fn attaches_lists_and_removes_system_and_custom_tags() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap();

    let tagged = attach_tag(&app, task_id, "NEEDS_USER_INPUT").await;
    assert_eq!(tagged["tags"].as_array().unwrap().len(), 1);
    assert_eq!(tagged["tags"][0]["name"], "NEEDS_USER_INPUT");
    assert_eq!(tagged["tags"][0]["is_system"], true);
    let system_tag_id = tagged["tags"][0]["id"].as_str().unwrap();

    let tagged_again = attach_tag(&app, task_id, "NEEDS_USER_INPUT").await;
    assert_eq!(tagged_again["tags"].as_array().unwrap().len(), 1);

    let custom = attach_tag(&app, task_id, "waiting-on-design").await;
    assert_eq!(custom["tags"].as_array().unwrap().len(), 2);
    let custom_tag = custom["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["name"] == "waiting-on-design")
        .unwrap();
    assert_eq!(custom_tag["is_system"], false);

    let response = app
        .clone()
        .oneshot(support::api_request(Method::GET, "/api/tags", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tags = support::json_body(response).await;
    assert_eq!(tags.as_array().unwrap().len(), 4);
    assert!(tags
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag["name"] == "FAILED"));

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::DELETE,
            &format!("/api/tasks/{task_id}/tags/{system_tag_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/tasks/{task_id}"),
            None,
        ))
        .await
        .unwrap();
    let task = support::json_body(response).await;
    assert_eq!(task["tags"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_invalid_tag_names() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app, "Tracker").await;
    let task = create_task(&app, project["id"].as_str().unwrap(), "Task").await;
    let task_id = task["id"].as_str().unwrap();

    for name in [" ", "needs_user_input"] {
        let response = app
            .clone()
            .oneshot(support::api_request(
                Method::POST,
                &format!("/api/tasks/{task_id}/tags"),
                Some(json!({"name": name})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn lists_only_attention_tasks_with_project_name_and_tags() {
    let app = ai_task_tracker::build_router(support::state().await);
    let project = create_project(&app, "Tracker").await;
    let project_id = project["id"].as_str().unwrap();
    let needs_input = create_task(&app, project_id, "Needs input").await;
    let failed = create_task(&app, project_id, "Failed").await;
    let ordinary = create_task(&app, project_id, "Ordinary").await;

    attach_tag(
        &app,
        needs_input["id"].as_str().unwrap(),
        "NEEDS_USER_INPUT",
    )
    .await;
    attach_tag(&app, failed["id"].as_str().unwrap(), "FAILED").await;
    attach_tag(&app, ordinary["id"].as_str().unwrap(), "waiting-on-design").await;

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            "/api/tasks/needs-attention",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let items = support::json_body(response).await;
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert!(items
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["project_name"] == "Tracker"));
    assert!(items.as_array().unwrap().iter().all(|item| {
        item["tags"].as_array().unwrap().iter().any(|tag| {
            ["NEEDS_USER_INPUT", "BLOCKED", "FAILED"].contains(&tag["name"].as_str().unwrap())
        })
    }));
}
