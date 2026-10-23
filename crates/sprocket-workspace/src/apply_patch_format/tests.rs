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
        [PatchSection::Update { chunks, .. }] => {
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
        [PatchSection::Add { path, contents }] => {
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
            PatchSection::Copy {
                path,
                copy_to,
                chunks,
            },
            PatchSection::Update {
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
        [PatchSection::Update { chunks, .. }] => {
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
        message.contains("'@@ -1 +1 @@': use '@@' or '@@ anchor text'"),
        "unexpected error: {message}"
    );
}

#[test]
fn parses_patch_without_envelope() {
    let hunks = parse_apply_patch(
        "*** Delete File: a.txt\n*** Add File: b.txt\n+b  \n*** Update File: c.txt\n-old\n \n",
    )
    .expect("parse");

    match &hunks[..] {
        [
            PatchSection::Delete { path },
            PatchSection::Add { contents, .. },
            PatchSection::Update { chunks, .. },
        ] => {
            assert_eq!(path, "a.txt");
            assert_eq!(contents, b"b  \n");
            assert_eq!(chunks[0].old_lines, vec!["old".to_owned(), String::new()]);
        }
        _ => panic!("expected delete, add, and update sections"),
    }
}

#[test]
fn parse_errors_quote_the_offending_line() {
    let error =
        parse_apply_patch("*** Begin Patch\n*** Update File: a.txt\n@@\n-old\nnew\n*** End Patch")
            .err()
            .expect("unprefixed update line must fail");
    assert_eq!(
        error.to_string(),
        "invalid update line 5 'new': lines must start with ' ', '+', or '-'"
    );

    let error = parse_apply_patch("--- a/a.txt\n+++ b/a.txt")
        .err()
        .expect("unified diffs are not supported");
    assert!(
        error.to_string().ends_with("(got '--- a/a.txt')"),
        "unexpected error: {error}"
    );
}

fn chunk(context: Option<&str>, old_lines: &[&str], new_lines: &[&str]) -> UpdateChunk {
    UpdateChunk {
        context: context.map(str::to_owned),
        old_lines: old_lines.iter().map(|line| (*line).to_owned()).collect(),
        new_lines: new_lines.iter().map(|line| (*line).to_owned()).collect(),
        end_of_file: false,
    }
}

#[test]
fn applies_out_of_order_hunks_with_unique_matches() {
    let updated = apply_update(
        Path::new("file.txt"),
        b"fn one() {}\nfn two() {}\nfn three() {}\n",
        &[
            chunk(None, &["fn three() {}"], &["fn THREE() {}"]),
            chunk(Some("fn one() {}"), &["fn two() {}"], &["fn TWO() {}"]),
            chunk(None, &["fn one() {}"], &["fn ONE() {}"]),
        ],
    )
    .expect("apply");

    assert_eq!(updated, b"fn ONE() {}\nfn TWO() {}\nfn THREE() {}\n");
}

#[test]
fn out_of_order_hunk_must_match_one_place() {
    let error = apply_update(
        Path::new("file.txt"),
        b"x\nend\nx\n",
        &[
            chunk(None, &["end"], &["END"]),
            chunk(None, &["missing"], &["found"]),
            chunk(None, &["x"], &["y"]),
        ],
    )
    .err()
    .expect("second hunk must not match");
    assert!(error.to_string().starts_with("hunk 2 of 3 did not match"));

    let error = apply_update(
        Path::new("file.txt"),
        b"x\nx\nend\n",
        &[chunk(None, &["end"], &["END"]), chunk(None, &["x"], &["z"])],
    )
    .err()
    .expect("both x lines are candidates");
    assert!(
        error
            .to_string()
            .contains("the expected lines match 2 places"),
        "unexpected error: {error}"
    );

    let error = apply_update(
        Path::new("file.txt"),
        b"a\nb\nc\nd\n",
        &[
            chunk(None, &["b", "c"], &["B", "C"]),
            chunk(Some("b"), &[], &["inserted"]),
        ],
    )
    .err()
    .expect("insertion inside an earlier hunk must fail");
    assert!(
        error
            .to_string()
            .contains("the anchor line is inside lines an earlier hunk changes"),
        "unexpected error: {error}"
    );
}

#[test]
fn mismatch_error_shows_the_closest_region() {
    let file = (1..=30)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    let error = apply_update(
        Path::new("/work/file.txt"),
        file.as_bytes(),
        &[chunk(
            Some("fn main"),
            &["line 20", "line 21 changed", "line 22"],
            &["new"],
        )],
    )
    .err()
    .expect("context must not match");

    assert_eq!(
        error.to_string(),
        "hunk 1 of 1 (@@ fn main) did not match /work/file.txt: the anchor line was not found. \
         No files were changed.\n\
         Closest region of the file (lines 17-24):\n\
         17 | line 17\n\
         18 | line 18\n\
         19 | line 19\n\
         20 | line 20\n\
         21 | line 21\n\
         22 | line 22\n\
         23 | line 23\n\
         24 | line 24"
    );
}
