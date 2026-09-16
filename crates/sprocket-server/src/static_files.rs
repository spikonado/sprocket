use std::path::{Component, Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode, header::CACHE_CONTROL};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_router(dir: PathBuf, api: Router) -> Router {
    let index = dir.join("index.html");
    let assets = ServeDir::new(dir.clone());

    Router::new()
        .nest("/api", api)
        .fallback_service(tower::service_fn(move |req: Request<Body>| {
            let dir = dir.clone();
            let index = index.clone();
            let assets = assets.clone();
            async move {
                Ok::<_, std::convert::Infallible>(
                    serve_static_request(req, &dir, &index, assets).await,
                )
            }
        }))
}

async fn serve_static_request(
    req: Request<Body>,
    dir: &Path,
    index: &Path,
    assets: ServeDir,
) -> Response {
    let path = req.uri().path();
    let immutable = path.starts_with("/_app/immutable/");

    let mut response = if path.starts_with("/_app/") {
        match assets.oneshot(req).await {
            Ok(response) => response.into_response(),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        }
    } else {
        let file = resolve_static_file(dir, path).unwrap_or_else(|| index.to_path_buf());
        serve_file(&file, req).await
    };

    let cache_control =
        if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
            if immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            }
        } else {
            "no-store"
        };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    response
}

fn resolve_static_file(dir: &Path, path: &str) -> Option<PathBuf> {
    let clean = path.trim_start_matches('/');

    if clean.is_empty() {
        return Some(dir.join("index.html"));
    }

    // Only Normal components: reject `..`, absolute/prefix segments, and `.`.
    let relative = Path::new(clean);
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }

    let direct = dir.join(relative);
    if direct.is_file() {
        return Some(direct);
    }

    let html = dir.join(format!("{clean}.html"));
    if html.is_file() {
        return Some(html);
    }

    None
}

async fn serve_file(path: &Path, req: Request<Body>) -> Response {
    match ServeFile::new(path).try_call(req).await {
        Ok(response) => response.into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests;
