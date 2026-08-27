use axum::{
    body::Body,
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../frontend/dist/"]
struct Assets;

pub async fn serve(uri: Uri) -> Response {
    let requested_path = uri.path().trim_start_matches('/');
    let path = if requested_path.is_empty() {
        "index.html"
    } else {
        requested_path
    };
    let (asset, asset_path) = match Assets::get(path) {
        Some(asset) => (asset, path),
        None => match Assets::get("index.html") {
            Some(asset) => (asset, "index.html"),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };

    let content_type = mime_guess::from_path(asset_path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned();
    let mut response = Response::new(Body::from(asset.data.into_owned()));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type).expect("MIME types are valid header values"),
    );
    response
}
