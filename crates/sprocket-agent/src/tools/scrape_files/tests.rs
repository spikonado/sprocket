use super::*;
use serde_json::json;

#[tokio::test]
async fn direct_scrapes_over_the_utf16_budget_save_markdown_until_completion() {
    let cache = tempfile::tempdir().unwrap();
    let cache_dir = cache.path().join("scrape_url");
    let fits = json!({"url": "https://example.com/page.md", "markdown": "😀".repeat(SCRAPE_INLINE_MAX_CHARS / 2)});
    let mut saved = None;
    assert_eq!(
        localize_scrape(
            fits.clone(),
            &cache_dir,
            &WorkspaceCancellation::new(),
            &mut saved
        )
        .await
        .unwrap(),
        fits
    );
    assert!(saved.is_none());

    let markdown = format!("{}x", "😀".repeat(SCRAPE_INLINE_MAX_CHARS / 2));
    let full = json!({"url": "https://example.com/page.md", "markdown": markdown});
    let result = localize_scrape(full, &cache_dir, &WorkspaceCancellation::new(), &mut saved)
        .await
        .unwrap();
    let file = saved.unwrap();
    let path = file.path().to_owned();
    assert_eq!(path.parent(), Some(cache_dir.as_path()));
    assert_eq!(path.extension().unwrap(), "md");
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), markdown);
    assert_eq!(
        result,
        json!({"url": "https://example.com/page.md", "savedTo": path.display().to_string(), "outline": {"headings": []}})
    );
    drop(file);
    assert!(!path.exists());
}

#[test]
fn saved_markdown_outline_uses_front_matter_and_headings_outside_code() {
    let markdown = "---\ntitle: '  PCB Editor '\ndescription: >\n  How to use\n  the editor\nsidebar: 3\n---\n\n# Introduction to `pcbnew`\n\n```sh\n# not a heading\n```\n\n## [Hotkeys](#hotkeys)\n\nBoard setup\n-----------\n";
    assert_eq!(
        markdown_outline(markdown),
        json!({
            "title": "PCB Editor",
            "description": "How to use the editor",
            "headings": [
                {"level": 1, "text": "Introduction to pcbnew"},
                {"level": 2, "text": "Hotkeys"},
                {"level": 2, "text": "Board setup"},
            ],
        })
    );
}

#[test]
fn saved_markdown_outline_clips_long_text() {
    let markdown = format!(
        "---\ndescription: {}\n---\n## a{}\n",
        "d".repeat(OUTLINE_DESCRIPTION_MAX_CHARS + 1),
        "😀".repeat(OUTLINE_HEADING_MAX_CHARS)
    );
    assert_eq!(
        markdown_outline(&markdown),
        json!({
            "description": "d".repeat(OUTLINE_DESCRIPTION_MAX_CHARS),
            "headings": [{"level": 2, "text": format!("a{}", "😀".repeat(OUTLINE_HEADING_MAX_CHARS - 1))}],
        })
    );
}

#[test]
fn saved_markdown_outline_keeps_every_chapter_before_deeper_headings() {
    let section = format!("### {}\n", "s".repeat(OUTLINE_HEADING_MAX_CHARS));
    let mut markdown: String = (0..20)
        .map(|chapter| format!("## Chapter {chapter}\n{}", section.repeat(3)))
        .collect();
    markdown.push_str("### Short\n");
    let outline = markdown_outline(&markdown);
    let headings = outline["headings"].as_array().unwrap();
    let chapters = headings.iter().filter(|heading| heading["level"] == 2);
    assert_eq!(chapters.count(), 20);
    assert_eq!(headings[1]["level"], 3);
    assert_eq!(headings.last().unwrap()["text"], "Chapter 19");
    assert!(json_chars(&outline) <= OUTLINE_MAX_CHARS);
}

#[tokio::test]
async fn cancelled_direct_saves_do_not_return_a_file() {
    let cache = tempfile::tempdir().unwrap();
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let mut saved = None;
    let error = localize_scrape(
        json!({"markdown": "x".repeat(SCRAPE_INLINE_MAX_CHARS + 1)}),
        cache.path(),
        &cancellation,
        &mut saved,
    )
    .await
    .unwrap_err();
    assert!(error.is::<WorkspaceOperationCancelled>());
    assert!(saved.is_none());
}
