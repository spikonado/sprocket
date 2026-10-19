use super::*;
use rig::message::DocumentSourceKind;

const SAMPLE_RTF: &str = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n{\\fonttbl{\\f0\\fcharset0 Arial;}}\n{\\stylesheet{\\s0 Normal;}}\n\\pard\\plain\\s0 Body before.\\par\n\\pard\\plain\\s0 Hello from RTF.\\par\n}\n"; // codespell:ignore pard
const SAMPLE_CSV: &str = "name,qty\nwidget,2\ngadget,9\n";

fn args(path: impl Into<String>) -> ParseFileArgs {
    ParseFileArgs { path: path.into() }
}

fn tiny_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([255, 0, 0])))
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .expect("encode png");
    bytes
}

fn tiny_jpeg() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([0, 255, 0])))
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
        .expect("encode jpeg");
    bytes
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "sprocket-parse-file-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&path).expect("temp dir");
    path
}

fn png_of_size(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([0, 0, 255]),
    ))
    .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
    .expect("encode png");
    bytes
}

fn decoded_image(output: &ToolOutput) -> (ImageMediaType, u32, u32) {
    let [_, ToolResultContent::Image(image)] = output.as_content() else {
        panic!("expected saved path and image block");
    };
    let DocumentSourceKind::Base64(data) = &image.data else {
        panic!("expected base64 image");
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64");
    decode_image_info(&bytes).expect("decode")
}

fn assert_png_image_output(output: &ToolOutput, png: &[u8]) {
    match output.as_content() {
        [ToolResultContent::Text(_), ToolResultContent::Image(image)] => {
            assert_eq!(image.media_type, Some(ImageMediaType::PNG));
            match &image.data {
                DocumentSourceKind::Base64(data) => {
                    assert_eq!(
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .expect("base64"),
                        png
                    );
                }
                other => panic!("expected base64 image, got {other:?}"),
            }
        }
        other => panic!("expected saved path and Rig image block, got {other:?}"),
    }
}

fn assert_text_contains(output: &ToolOutput, needle: &str) {
    match output.as_content() {
        [ToolResultContent::Text(text)] => {
            assert!(
                text.text.contains(needle),
                "expected {needle:?} in {}",
                text.text
            );
        }
        other => panic!("expected one text block, got {other:?}"),
    }
}

async fn persist(
    workspace: &Path,
    cache: &Path,
    path: &str,
) -> anyhow::Result<ParseFilePersistedOutput> {
    persist_with_images(workspace, cache, true, path).await
}

async fn persist_with_images(
    workspace: &Path,
    cache: &Path,
    supports_images: bool,
    path: &str,
) -> anyhow::Result<ParseFilePersistedOutput> {
    persist_parse_file(
        workspace,
        cache,
        WorkspaceCancellation::new(),
        supports_images,
        args(path),
        None,
    )
    .await
}

#[test]
fn replay_metadata_accepts_convex_float_numbers() {
    let output: ParseFilePersistedOutput = serde_json::from_value(json!({
        "outputType": "image", "mediaType": "image/png", "path": "/cache/image.png",
        "source": { "type": "path", "path": "image.png" },
        "byteSize": 123.0, "width": 1.0, "height": 2.0
    }))
    .unwrap();
    assert!(matches!(
        output,
        ParseFilePersistedOutput::Image {
            byte_size: 123,
            width: 1,
            height: 2,
            ..
        }
    ));
}

#[test]
fn args_require_a_local_path_and_reject_urls() {
    let empty = parse_file_args(&args("  ")).expect_err("empty");
    assert!(empty.to_string().contains("path"), "{empty}");

    for value in [
        json!({"url": "https://example.com/a.png"}),
        json!({"path": "/tmp/a.png", "url": "https://example.com/a.png"}),
    ] {
        assert!(serde_json::from_value::<ParseFileArgs>(value).is_err());
    }

    for path in ["https://example.com/a.png", "http://example.com/a.png"] {
        let error = parse_file_args(&args(path)).expect_err(path);
        assert!(error.to_string().contains("scrape_url"), "{path}: {error}");
    }
    for path in [
        "file:///tmp/a.png",
        "data:image/png;base64,aaa",
        "ftp://example.com/a.png",
    ] {
        let error = parse_file_args(&args(path)).expect_err(path);
        assert!(
            error.to_string().contains("local filesystem path"),
            "{path}: {error}"
        );
    }

    assert_eq!(
        parse_file_args(&args("shots/a.png")).unwrap(),
        "shots/a.png"
    );
}

#[test]
fn windows_drive_path_is_not_treated_as_a_url() {
    let parsed = parse_file_args(&args(r"C:\Users\me\shot.png")).expect("drive path");
    assert_eq!(parsed, r"C:\Users\me\shot.png");
}

#[test]
fn decode_sniffs_magic_and_rejects_unknown_or_truncated_headers() {
    let png = tiny_png();
    let (media_type, width, height) = decode_image_info(&png).expect("png");
    assert_eq!(media_type, ImageMediaType::PNG);
    assert_eq!((width, height), (1, 1));

    let jpeg = tiny_jpeg();
    let (media_type, _, _) = decode_image_info(&jpeg).expect("jpeg");
    assert_eq!(media_type, ImageMediaType::JPEG);

    let text = decode_image_info(b"not an image").expect_err("text");
    assert!(text.to_string().contains("unknown image format"), "{text}");

    let bmp = decode_image_info(b"BM\0\0\0\0\0\0\0\0\0\0").expect_err("bmp");
    assert!(bmp.to_string().contains("unknown image format"), "{bmp}");

    let truncated = decode_image_info(&png[..8]).expect_err("truncated png");
    assert!(
        truncated.to_string().contains("header") || truncated.to_string().contains("format"),
        "{truncated}"
    );
}

#[test]
fn model_bounds_are_separate_from_attachment_storage() {
    ensure_image_within_model_bounds(1, 1, 16).expect("ok");
    let too_big = ensure_image_within_model_bounds(1, 1, (MAX_PARSE_FILE_IMAGE_BYTES as u64) + 1)
        .expect_err("bytes");
    assert!(
        too_big
            .to_string()
            .contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string())
    );
    let too_wide = ensure_image_within_model_bounds(MAX_PARSE_FILE_IMAGE_DIMENSION + 1, 1, 16)
        .expect_err("width");
    assert!(too_wide.to_string().contains("8192"));
    let too_many_pixels = ensure_image_within_model_bounds(7000, 7000, 16).expect_err("pixels");
    assert!(too_many_pixels.to_string().contains("pixels"));
}

#[tokio::test]
async fn refuses_oversized_local_documents_without_removing_the_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("large.txt");
    std::fs::File::create(&source)
        .unwrap()
        .set_len(MAX_PARSE_FILE_DOCUMENT_BYTES + 1)
        .unwrap();
    let cache = dir.path().join("parsed");
    let error = persist(dir.path(), &cache, &source.to_string_lossy())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("64 MiB"), "{error}");
    assert!(source.exists());
    assert!(!cache.exists());
}

#[tokio::test]
async fn failed_local_conversion_automatically_caches_hosted_markdown() {
    let dir = tempfile::tempdir().unwrap();
    let cancellation = WorkspaceCancellation::new();
    let error = LocalConversionFailed("scanned PDF needs OCR".into());
    let parsed = local_or_hosted(
        Err(error.into()),
        dir.path().into(),
        &cancellation,
        || async { Ok("# Scanned page\nRecognized text".into()) },
    )
    .await
    .unwrap();
    assert_eq!(parsed.format, "firecrawl");
    assert!(parsed.preview.contains("Recognized text"));
    assert_eq!(
        std::fs::read_to_string(parsed.path).unwrap(),
        parsed.preview
    );
}

#[tokio::test]
async fn hosted_fallback_does_not_run_on_success_io_errors_or_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let cancellation = WorkspaceCancellation::new();
    let local = persist_parsed_text(dir.path(), "local text", "text", &cancellation).unwrap();
    let parsed = local_or_hosted(Ok(local), dir.path().into(), &cancellation, || async {
        panic!("successful local parsing must not contact Firecrawl")
    })
    .await
    .unwrap();
    assert_eq!(parsed.format, "text");
    let error = local_or_hosted(
        Err(std::io::Error::other("disk full").into()),
        dir.path().into(),
        &cancellation,
        || async { panic!("cache errors must not upload documents") },
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("disk full"));
    cancellation.cancel();
    let error = local_or_hosted(
        Err(LocalConversionFailed("bad PDF".into()).into()),
        dir.path().into(),
        &cancellation,
        || async { panic!("cancellation must not upload documents") },
    )
    .await
    .err()
    .unwrap();
    assert!(error.is::<WorkspaceOperationCancelled>());
}

#[test]
fn csv_without_signature_is_named_from_the_path() {
    let csv = SAMPLE_CSV.as_bytes();
    assert!(anydoc::Format::from_bytes(csv).is_none());
    assert_eq!(
        detect_anydoc_format(csv, Path::new("data.csv")),
        Some(anydoc::Format::Csv)
    );
}

#[tokio::test]
async fn persist_and_replay_round_trip_from_a_local_path() {
    let png = tiny_png();
    let workspace = temp_dir("workspace");
    let cache = temp_dir("cache");
    let source = workspace.join("shot.png");
    tokio::fs::write(&source, &png).await.expect("write");

    let persisted = persist(&workspace, &cache, "shot.png")
        .await
        .expect("persist");

    match &persisted {
        ParseFilePersistedOutput::Image {
            media_type,
            width,
            height,
            byte_size,
            path,
            source,
        } => {
            assert_eq!(media_type, "image/png");
            assert_eq!((*width, *height), (1, 1));
            assert_eq!(*byte_size, png.len() as u64);
            assert_eq!(
                Path::new(path).parent(),
                Some(std::fs::canonicalize(&cache).expect("cache").as_path())
            );
            let ParseFilePersistedSource::Path { path } = source;
            assert_eq!(path, "shot.png");
        }
        other => panic!("expected image output, got {other:?}"),
    }

    let value = serde_json::to_value(&persisted).expect("value");
    assert!(!value.to_string().contains("iVBORw0KGgo"));
    assert_eq!(value["outputType"], "image");
    assert_eq!(value["mediaType"], "image/png");

    let output = replay_tool_output(&value, None).await.expect("replay");
    assert_png_image_output(&output, &png);
    let ToolResultContent::Text(saved_path) = &output.as_content()[0] else {
        panic!("missing image path");
    };
    assert_eq!(
        saved_path.text,
        format!("Image saved to: {}", value["path"].as_str().unwrap())
    );

    let history = replay_local_tool_output(&value)
        .await
        .expect("history")
        .into_history_items(&ImageUrlMap::new())
        .expect("history");
    assert_eq!(history.len(), 2);
    let AgentHistoryToolResultItem::Text { text } = &history[0] else {
        panic!("missing history image path");
    };
    assert_eq!(text, &saved_path.text);
    match &history[1] {
        AgentHistoryToolResultItem::Image { image_json } => {
            assert!(image_json.contains("base64") || image_json.contains("iVBORw0KGgo"));
        }
        other => panic!("expected history image, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn rtf_converts_through_anydoc() {
    let workspace = temp_dir("rtf");
    let cache = temp_dir("rtf-cache");
    tokio::fs::write(workspace.join("note.rtf"), SAMPLE_RTF)
        .await
        .expect("write");

    let persisted = persist(&workspace, &cache, "note.rtf").await.expect("rtf");

    match &persisted {
        ParseFilePersistedOutput::Text {
            format,
            preview,
            truncated,
            path,
            ..
        } => {
            assert_eq!(format, "rtf");
            assert!(!*truncated);
            assert!(preview.contains("Hello from RTF"), "{preview}");
            let cached = tokio::fs::read_to_string(path).await.expect("cache");
            assert!(cached.contains("Hello from RTF"));
        }
        other => panic!("expected text output, got {other:?}"),
    }

    let value = serde_json::to_value(&persisted).expect("value");
    assert_eq!(value["outputType"], "text");
    let output = replay_tool_output(&value, None).await.expect("replay");
    assert_text_contains(&output, "Hello from RTF");

    let history = replay_local_tool_output(&value)
        .await
        .expect("history")
        .into_history_items(&ImageUrlMap::new())
        .expect("history");
    match &history[0] {
        AgentHistoryToolResultItem::Text { text } => {
            assert!(text.contains("Hello from RTF"));
        }
        other => panic!("expected history text, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn csv_without_signature_converts_from_a_local_path() {
    let workspace = temp_dir("csv");
    let cache = temp_dir("csv-cache");
    tokio::fs::write(workspace.join("export.csv"), SAMPLE_CSV)
        .await
        .expect("write");

    let persisted = persist(&workspace, &cache, "export.csv")
        .await
        .expect("csv");

    match &persisted {
        ParseFilePersistedOutput::Text {
            format, preview, ..
        } => {
            assert_eq!(format, "csv");
            assert!(
                preview.contains("widget") && preview.contains("gadget"),
                "{preview}"
            );
        }
        other => panic!("expected text output, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn utf8_source_is_returned_as_text() {
    let workspace = temp_dir("utf8");
    let cache = temp_dir("utf8-cache");
    tokio::fs::write(workspace.join("main.rs"), "fn main() {}\n")
        .await
        .expect("write");

    let persisted = persist(&workspace, &cache, "main.rs").await.expect("utf8");

    match persisted {
        ParseFilePersistedOutput::Text {
            format, preview, ..
        } => {
            assert_eq!(format, "text");
            assert!(preview.contains("fn main()"));
        }
        other => panic!("expected text output, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn text_only_model_rejects_images_and_still_parses_documents() {
    let workspace = temp_dir("text-model");
    let cache = temp_dir("text-model-cache");
    tokio::fs::write(workspace.join("shot.png"), tiny_png())
        .await
        .expect("png");
    tokio::fs::write(workspace.join("note.rtf"), SAMPLE_RTF)
        .await
        .expect("rtf");

    let image = persist_with_images(&workspace, &cache, false, "shot.png")
        .await
        .expect_err("image");
    assert!(
        image.to_string().contains("does not support images"),
        "{image}"
    );

    let doc = persist_with_images(&workspace, &cache, false, "note.rtf")
        .await
        .expect("rtf on text model");
    match doc {
        ParseFilePersistedOutput::Text { preview, .. } => {
            assert!(preview.contains("Hello from RTF"));
        }
        other => panic!("expected text output, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn long_text_is_cached_in_full_and_previewed_for_convex() {
    let workspace = temp_dir("truncate");
    let cache = temp_dir("truncate-cache");
    let tail = "UNIQUE-PARSE-FILE-TAIL";
    let full = format!("{}{tail}", "x".repeat(MAX_PARSE_FILE_PREVIEW_CHARS + 32));
    tokio::fs::write(workspace.join("long.txt"), &full)
        .await
        .expect("write");

    let persisted = persist(&workspace, &cache, "long.txt").await.expect("long");

    match &persisted {
        ParseFilePersistedOutput::Text {
            preview,
            truncated,
            char_count,
            path,
            ..
        } => {
            assert!(*truncated);
            assert_eq!(*char_count, full.chars().count() as u64);
            assert_eq!(preview.chars().count(), MAX_PARSE_FILE_PREVIEW_CHARS);
            assert!(!preview.contains(tail));
            let cached = tokio::fs::read_to_string(path).await.expect("cache");
            assert!(cached.ends_with(tail));
        }
        other => panic!("expected text output, got {other:?}"),
    }

    let value = serde_json::to_value(&persisted).expect("value");
    assert!(!value.to_string().contains(tail));
    assert_eq!(value["truncated"], true);

    let output = replay_tool_output(&value, None).await.expect("replay");
    match output.as_content() {
        [ToolResultContent::Text(text)] => {
            assert!(text.text.contains("...[truncated]"));
            assert!(text.text.contains("characters at"));
            assert!(!text.text.contains(tail));
        }
        other => panic!("expected text, got {other:?}"),
    }

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn missing_replay_cache_reports_missing_files() {
    let value = serde_json::json!({
        "outputType": "image",
        "mediaType": "image/png",
        "path": "/tmp/sprocket-parse-file-missing-cache.png",
        "source": { "type": "path", "path": "image.png" },
        "byteSize": 16,
        "width": 1,
        "height": 1
    });
    let error = replay_tool_output(&value, None)
        .await
        .expect_err("missing cache");
    let message = format!("{error:#}");
    assert!(
        message.contains("cached image") || message.contains("failed to open"),
        "{message}"
    );

    let text = serde_json::json!({
        "outputType": "text",
        "path": "/tmp/sprocket-parse-file-missing-text.md",
        "source": { "type": "path", "path": "note.csv" },
        "format": "csv",
        "charCount": 4,
        "preview": "name",
        "truncated": false
    });
    let text_error = replay_tool_output(&text, None)
        .await
        .expect_err("missing text cache");
    let text_message = format!("{text_error:#}");
    assert!(text_message.contains("cached text"), "{text_message}");
}

#[tokio::test]
async fn oversized_images_are_downscaled_when_persisted_and_when_replayed_from_old_caches() {
    let workspace = temp_dir("downscale");
    let cache = temp_dir("downscale-cache");
    let large = png_of_size(3000, 1500);
    tokio::fs::write(workspace.join("large.png"), &large)
        .await
        .expect("write");

    let persisted = persist(&workspace, &cache, "large.png")
        .await
        .expect("persist");
    let ParseFilePersistedOutput::Image { width, height, .. } = &persisted else {
        panic!("expected image output, got {persisted:?}");
    };
    assert_eq!((*width, *height), (2000, 1000));
    let value = serde_json::to_value(&persisted).expect("value");
    let output = replay_tool_output(&value, None).await.expect("replay");
    assert_eq!(decoded_image(&output), (ImageMediaType::PNG, 2000, 1000));

    let legacy_path = cache.join("legacy.png");
    tokio::fs::write(&legacy_path, &large)
        .await
        .expect("write legacy");
    let legacy = serde_json::json!({
        "outputType": "image",
        "mediaType": "image/png",
        "path": legacy_path,
        "source": { "type": "path", "path": "large.png" },
        "byteSize": large.len(),
        "width": 3000,
        "height": 1500
    });
    let output = replay_tool_output(&legacy, None)
        .await
        .expect("replay legacy");
    assert_eq!(decoded_image(&output), (ImageMediaType::PNG, 2000, 1000));

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[test]
fn images_too_heavy_as_png_are_re_encoded_as_jpeg() {
    let mut state = 0x2545_f491_u32;
    let noise = image::RgbImage::from_fn(1500, 1500, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let [r, g, b, _] = state.to_le_bytes();
        image::Rgb([r, g, b])
    });
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(noise)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encode png");
    assert!(png.len() > MAX_MODEL_IMAGE_BYTES);

    let fitted = fit_image_for_model(png).expect("fit");
    assert_eq!(fitted.media_type, ImageMediaType::JPEG);
    assert_eq!(fitted.width, fitted.height);
    assert!(fitted.bytes.len() <= MAX_MODEL_IMAGE_BYTES);
}

#[test]
fn transparent_pixels_flatten_to_white_for_jpeg() {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(2, 1, |x, _| {
        if x == 0 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([0, 0, 0, 255])
        }
    }));
    let flat = flatten_onto_white(&image);
    assert_eq!(flat.get_pixel(0, 0).0, [255, 255, 255]);
    assert_eq!(flat.get_pixel(1, 0).0, [0, 0, 0]);
}

#[tokio::test]
async fn local_and_replay_reads_are_bounded_without_trusting_size_metadata() {
    let workspace = temp_dir("oversize");
    let cache = temp_dir("oversize-cache");
    let path = workspace.join("huge.png");
    tokio::fs::write(&path, tiny_png()).await.expect("write");
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .await
        .expect("open");
    file.set_len(MAX_PARSE_FILE_IMAGE_BYTES as u64 + 64)
        .await
        .expect("set_len");
    drop(file);

    let live = persist(&workspace, &cache, "huge.png")
        .await
        .expect_err("live oversize");
    assert!(
        live.to_string()
            .contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string())
    );

    let spoofed = serde_json::json!({
        "outputType": "image",
        "mediaType": "image/png",
        "path": path,
        "source": { "type": "path", "path": "huge.png" },
        "byteSize": 16,
        "width": 1,
        "height": 1
    });
    let replay = replay_tool_output(&spoofed, None)
        .await
        .expect_err("replay oversize");
    assert!(
        format!("{replay:#}").contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string()),
        "{replay:#}"
    );

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn local_path_rejects_missing_files_and_directories() {
    let workspace = temp_dir("missing");
    let cache = temp_dir("missing-cache");
    let missing = persist(&workspace, &cache, "nope.png")
        .await
        .expect_err("missing");
    assert!(
        missing.to_string().contains("failed to open") || missing.to_string().contains("No such")
    );

    let dir_error = persist(&workspace, &cache, ".").await.expect_err("dir");
    assert!(dir_error.to_string().contains("not a file"));

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn binary_non_document_is_rejected() {
    let workspace = temp_dir("binary");
    let cache = temp_dir("binary-cache");
    tokio::fs::write(workspace.join("blob.bin"), [0u8, 1, 2, 3, 255])
        .await
        .expect("write");
    let error = persist(&workspace, &cache, "blob.bin")
        .await
        .expect_err("binary");
    assert!(error.to_string().contains("unsupported file"), "{error}");

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn cancellation_stops_a_local_read() {
    let workspace = temp_dir("cancel");
    let cache = temp_dir("cancel-cache");
    tokio::fs::write(workspace.join("shot.png"), tiny_png())
        .await
        .expect("write");
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let error = persist_parse_file(
        &workspace,
        &cache,
        cancellation,
        true,
        args("shot.png"),
        None,
    )
    .await
    .expect_err("cancelled");
    assert!(error.is::<WorkspaceOperationCancelled>() || error.to_string().contains("cancelled"));

    let _ = tokio::fs::remove_dir_all(workspace).await;
    let _ = tokio::fs::remove_dir_all(cache).await;
}

#[tokio::test]
async fn parsed_images_and_text_share_the_parse_file_transcript_directory() {
    let root = tempfile::tempdir().unwrap();
    let store = sprocket_transcript::TranscriptStore::new(root.path().join("transcripts"));
    let thread = store.thread_dir("user", "thread");
    tokio::fs::write(root.path().join("shot.png"), tiny_png())
        .await
        .unwrap();
    tokio::fs::write(root.path().join("note.txt"), "hello")
        .await
        .unwrap();
    let directory = thread.join(PARSE_FILE_TOOL_NAME);
    for source in ["shot.png", "note.txt"] {
        let output = persist(root.path(), &directory, source).await.unwrap();
        let value = serde_json::to_value(output).unwrap();
        let path = Path::new(value["path"].as_str().unwrap());
        assert_eq!(path.parent().unwrap(), directory.canonicalize().unwrap());
    }
    assert!(!store.thread_dir("user", "another-thread").exists());
    assert!(!store.thread_dir("another-user", "thread").exists());
}

#[test]
fn identifies_only_parse_file() {
    assert!(is_parse_file_tool("parse_file"));
    assert!(!is_parse_file_tool("read_skill"));
    assert!(!is_parse_file_tool("read_image"));
}
