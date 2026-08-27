use ai_task_tracker::models::Status;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

mod support;

#[tokio::test]
async fn health_check_is_public_and_returns_ok() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[test]
fn status_allows_one_step_forward_and_any_backward_rework() {
    assert!(Status::ToDo.can_transition_to(Status::ToAgent));
    assert!(Status::ToAgent.can_transition_to(Status::ToReview));
    assert!(Status::ToReview.can_transition_to(Status::ToDeploy));
    assert!(Status::ToDeploy.can_transition_to(Status::Done));
    assert!(Status::ToReview.can_transition_to(Status::ToAgent));
    assert!(Status::ToDeploy.can_transition_to(Status::ToDo));
    assert!(!Status::ToDo.can_transition_to(Status::ToReview));
    assert!(!Status::Done.can_transition_to(Status::Done));
}

#[tokio::test]
async fn api_routes_reject_missing_or_invalid_key() {
    let state = support::state().await;
    let app = ai_task_tracker::build_router(state);

    for key in [None, Some("wrong")] {
        let mut request = Request::builder()
            .uri("/api/projects")
            .body(Body::empty())
            .unwrap();
        if let Some(key) = key {
            request
                .headers_mut()
                .insert("x-api-key", key.parse().unwrap());
        }
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn api_routes_accept_a_valid_key() {
    let app = ai_task_tracker::build_router(support::state().await);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/projects")
                .header("x-api-key", "test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn unknown_api_routes_require_an_api_key_and_return_json_errors() {
    let app = ai_task_tracker::build_router(support::state().await);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/unknown")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(support::json_body(response).await["code"], "UNAUTHORIZED");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/unknown")
                .header("x-api-key", "test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(support::json_body(response).await["code"], "NOT_FOUND");
}

#[tokio::test]
async fn api_method_and_json_rejections_use_json_errors() {
    let app = ai_task_tracker::build_router(support::state().await);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tags")
                .header("x-api-key", "test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        support::json_body(response).await["code"],
        "METHOD_NOT_ALLOWED"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/projects")
                .header("x-api-key", "test-key")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(support::json_body(response).await["code"], "BAD_REQUEST");

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/projects")
                .header("x-api-key", "test-key")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name": 1}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        support::json_body(response).await["code"],
        "UNPROCESSABLE_ENTITY"
    );
}

#[tokio::test]
async fn api_content_type_rejections_use_json_errors() {
    let app = ai_task_tracker::build_router(support::state().await);

    for content_type in [None, Some("text/plain")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/projects")
            .header("x-api-key", "test-key");
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(r#"{"name":"Tracker"}"#)).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(
            support::json_body(response).await["code"],
            "UNSUPPORTED_MEDIA_TYPE"
        );
    }
}

#[tokio::test]
async fn api_payload_too_large_rejection_uses_a_json_error() {
    let app = ai_task_tracker::build_router(support::state().await);
    let body = format!(r#"{{"name":"{}"}}"#, "a".repeat(2 * 1024 * 1024));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/projects")
                .header("x-api-key", "test-key")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        support::json_body(response).await["code"],
        "PAYLOAD_TOO_LARGE"
    );
}

#[tokio::test]
async fn spa_fallback_serves_embedded_index_without_intercepting_health_or_api() {
    let app = ai_task_tracker::build_router(support::state().await);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/projects/example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert!(std::str::from_utf8(&body)
        .unwrap()
        .contains("<div id=\"root\"></div>"));

    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    let unauthenticated_api = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthenticated_api.status(), StatusCode::UNAUTHORIZED);

    let authenticated_api = app
        .oneshot(
            Request::builder()
                .uri("/api/projects")
                .header("x-api-key", "test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(authenticated_api.status(), StatusCode::OK);
}
