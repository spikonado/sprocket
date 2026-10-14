use super::*;

#[test]
fn ignores_blank_lines_after_end_of_file() {
    let hunks = parse_apply_patch(
        "*** Begin Patch\n\
             *** Update File: file.txt\n\
             @@\n\
             +quux\n\
             *** End of File\n\
             \n\
             *** End Patch",
    )
    .expect("parse");

    match &hunks[..] {
        [PatchHunk::Update { chunks, .. }] => {
            assert_eq!(chunks.len(), 1);
            assert_eq!(chunks[0].old_lines, Vec::<String>::new());
            assert_eq!(chunks[0].new_lines, vec!["quux".to_owned()]);
            assert!(chunks[0].end_of_file);
        }
        _ => panic!("expected a single update hunk"),
    }
}

#[test]
fn applies_update_with_trailing_newline_sentinel() {
    let updated = apply_update(
        Path::new("file.txt"),
        b"alpha\nbeta\n",
        &[UpdateChunk {
            context: None,
            old_lines: vec!["beta".to_owned(), String::new()],
            new_lines: vec!["beta".to_owned(), "gamma".to_owned(), String::new()],
            end_of_file: true,
        }],
    )
    .expect("apply");

    assert_eq!(updated, b"alpha\nbeta\ngamma\n");
}

#[test]
fn preserves_missing_trailing_newline() {
    let updated = apply_update(
        Path::new("file.txt"),
        b"alpha\nbeta",
        &[UpdateChunk {
            context: None,
            old_lines: vec!["alpha".to_owned()],
            new_lines: vec!["ALPHA".to_owned()],
            end_of_file: false,
        }],
    )
    .expect("apply");

    assert_eq!(updated, b"ALPHA\nbeta");
}

#[test]
fn parses_empty_add_file() {
    let hunks = parse_apply_patch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch")
        .expect("parse");

    match &hunks[..] {
        [PatchHunk::Add { path, contents }] => {
            assert_eq!(path, "empty.txt");
            assert!(contents.is_empty());
        }
        _ => panic!("expected empty add hunk"),
    }
}

#[test]
fn deleting_all_content_yields_empty_file() {
    let updated = apply_update(
        Path::new("file.txt"),
        b"only\n",
        &[UpdateChunk {
            context: None,
            old_lines: vec!["only".to_owned()],
            new_lines: Vec::new(),
            end_of_file: true,
        }],
    )
    .expect("apply");

    assert_eq!(updated, b"");
}

#[test]
fn parses_copy_and_rename_only() {
    let hunks = parse_apply_patch(
        "*** Begin Patch\n\
             *** Copy File: src.txt\n\
             *** Copy to: dest.txt\n\
             *** Update File: old.txt\n\
             *** Move to: new.txt\n\
             *** End Patch",
    )
    .expect("parse");

    match &hunks[..] {
        [
            PatchHunk::Copy {
                path,
                copy_to,
                chunks,
            },
            PatchHunk::Update {
                path: update_path,
                move_to,
                chunks: update_chunks,
            },
        ] => {
            assert_eq!(path, "src.txt");
            assert_eq!(copy_to, "dest.txt");
            assert!(chunks.is_empty());
            assert_eq!(update_path, "old.txt");
            assert_eq!(move_to.as_deref(), Some("new.txt"));
            assert!(update_chunks.is_empty());
        }
        _ => panic!("expected copy and rename-only update"),
    }
}

#[test]
fn indented_update_marker_is_not_a_file_header() {
    // Keep the leading space on the context line; do not use `\` line
    // continuations here because Rust would eat that indentation.
    let hunks = parse_apply_patch(
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n *** Update File: example\n+new\n*** End Patch",
    )
    .expect("parse");

    match &hunks[..] {
        [PatchHunk::Update { chunks, .. }] => {
            assert_eq!(chunks.len(), 1);
            assert_eq!(
                chunks[0].old_lines,
                vec!["old".to_owned(), "*** Update File: example".to_owned()]
            );
            assert_eq!(
                chunks[0].new_lines,
                vec!["*** Update File: example".to_owned(), "new".to_owned()]
            );
        }
        _ => panic!("expected a single update hunk"),
    }
}

#[test]
fn rejects_unified_style_hunk_headers_in_begin_patch() {
    let error = parse_apply_patch(
        "*** Begin Patch\n\
             *** Update File: file.txt\n\
             @@ -1 +1 @@\n\
             -before\n\
             +after\n\
             *** End Patch",
    )
    .err()
    .expect("unified @@ ranges must not parse as Begin Patch anchors");

    let message = format!("{error:#}");
    assert!(
        message.contains("Begin Patch wants '@@' or '@@ anchor text' only"),
        "unexpected error: {message}"
    );
    assert!(
        message.contains("unified/`diff --git`"),
        "unexpected error: {message}"
    );
}
