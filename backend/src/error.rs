use axum::{
    extract::Request,
    http::{header::CONTENT_TYPE, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: String,
    pub code: String,
}

pub enum AppError {
    Unauthorized,
    NotFound,
    MethodNotAllowed,
    BadRequest(String),
    UnprocessableEntity(String),
    PayloadTooLarge,
    UnsupportedMediaType,
    Validation(String),
    InvalidTransition(String),
    Internal(sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error, code) = match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized".to_owned(),
                "UNAUTHORIZED".to_owned(),
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "not found".to_owned(),
                "NOT_FOUND".to_owned(),
            ),
            Self::MethodNotAllowed => (
                StatusCode::METHOD_NOT_ALLOWED,
                "method not allowed".to_owned(),
                "METHOD_NOT_ALLOWED".to_owned(),
            ),
            Self::BadRequest(message) => {
                (StatusCode::BAD_REQUEST, message, "BAD_REQUEST".to_owned())
            }
            Self::UnprocessableEntity(message) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                message,
                "UNPROCESSABLE_ENTITY".to_owned(),
            ),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload too large".to_owned(),
                "PAYLOAD_TOO_LARGE".to_owned(),
            ),
            Self::UnsupportedMediaType => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported media type".to_owned(),
                "UNSUPPORTED_MEDIA_TYPE".to_owned(),
            ),
            Self::Validation(message) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                message,
                "VALIDATION_ERROR".to_owned(),
            ),
            Self::InvalidTransition(message) => (
                StatusCode::CONFLICT,
                message,
                "INVALID_TRANSITION".to_owned(),
            ),
            Self::Internal(error) => {
                eprintln!("internal database error: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_owned(),
                    "INTERNAL_ERROR".to_owned(),
                )
            }
        };

        (status, Json(ErrorBody { error, code })).into_response()
    }
}

pub async fn normalize_api_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if response
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes().starts_with(b"application/json"))
    {
        return response;
    }

    match response.status() {
        StatusCode::NOT_FOUND => AppError::NotFound.into_response(),
        StatusCode::METHOD_NOT_ALLOWED => AppError::MethodNotAllowed.into_response(),
        StatusCode::BAD_REQUEST => {
            AppError::BadRequest("invalid JSON request body".to_owned()).into_response()
        }
        StatusCode::UNPROCESSABLE_ENTITY => {
            AppError::UnprocessableEntity("invalid JSON request body".to_owned()).into_response()
        }
        StatusCode::PAYLOAD_TOO_LARGE => AppError::PayloadTooLarge.into_response(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => AppError::UnsupportedMediaType.into_response(),
        _ => response,
    }
}
