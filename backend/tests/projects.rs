use axum::http::{Method, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod support;

#[tokio::test]
async fn creates_and_lists_projects_with_api_model_fields() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": "Tracker", "description": "Work"})),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let project = support::json_body(response).await;
    assert!(project["id"].as_str().is_some());
    assert_eq!(project["name"], "Tracker");
    assert_eq!(project["description"], "Work");
    assert!(project["created_at"].as_str().is_some());

    let response = app
        .oneshot(support::api_request(Method::GET, "/api/projects", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(support::json_body(response).await, json!([project]));
}

#[tokio::test]
async fn updates_deletes_and_reports_missing_projects() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": "Tracker"})),
        ))
        .await
        .unwrap();
    let project = support::json_body(response).await;
    let id = project["id"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/projects/{id}"),
            Some(json!({"name": "Renamed"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated = support::json_body(response).await;
    assert_eq!(updated["name"], "Renamed");
    assert_eq!(updated["description"], serde_json::Value::Null);

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::DELETE,
            &format!("/api/projects/{id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .oneshot(support::api_request(
            Method::GET,
            &format!("/api/projects/{id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejects_whitespace_only_project_names() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": "   "})),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = support::json_body(response).await;
    assert_eq!(body["error"], "project name is required");
    assert_eq!(body["code"], "VALIDATION_ERROR");
}

#[tokio::test]
async fn project_patch_distinguishes_omitted_and_null_descriptions() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::POST,
            "/api/projects",
            Some(json!({"name": "Tracker", "description": "Work"})),
        ))
        .await
        .unwrap();
    let project = support::json_body(response).await;
    let id = project["id"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/projects/{id}"),
            Some(json!({"name": "Renamed"})),
        ))
        .await
        .unwrap();
    assert_eq!(support::json_body(response).await["description"], "Work");

    let response = app
        .oneshot(support::api_request(
            Method::PATCH,
            &format!("/api/projects/{id}"),
            Some(json!({"description": null})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        support::json_body(response).await["description"],
        json!(null)
    );
}
