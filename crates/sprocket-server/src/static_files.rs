use std::path::{Component, Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
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

    if path.starts_with("/_app/") {
        return match assets.oneshot(req).await {
            Ok(response) => response.into_response(),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        };
    }

    match resolve_static_file(dir, path) {
        Some(file_path) => serve_file(&file_path).await,
        None => serve_file(index).await,
    }
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

async fn serve_file(path: &Path) -> Response {
    match ServeFile::new(path).try_call(Request::new(())).await {
        Ok(response) => response.into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_prerendered_html_routes() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist");

        if !dir.join("pair.html").exists() {
            return;
        }

        assert_eq!(
            resolve_static_file(&dir, "/pair"),
            Some(dir.join("pair.html"))
        );
        assert_eq!(
            resolve_static_file(&dir, "/callback"),
            Some(dir.join("callback.html"))
        );
    }

    #[test]
    fn rejects_path_traversal_and_absolute_segments() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist");

        assert_eq!(resolve_static_file(&dir, "/../Cargo.toml"), None);
        assert_eq!(resolve_static_file(&dir, "/foo/../../Cargo.toml"), None);
        assert_eq!(resolve_static_file(&dir, "/./pair"), None);
        // `C:` is a Prefix component only on Windows. On Unix it is a normal
        // path segment, so drive-style rejection is Windows-only.
        #[cfg(windows)]
        assert_eq!(resolve_static_file(&dir, "/C:/Windows/win.ini"), None);
    }
}
