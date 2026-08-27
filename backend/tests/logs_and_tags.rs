use axum::{
    http::{Method, StatusCode},
    Router,
};
use serde_json::{json, Value};
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
