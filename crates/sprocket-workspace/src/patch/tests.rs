use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;

use super::{FileSnapshot, PatchSnapshot, apply_workspace_patch, restore_snapshot};
use crate::commands::{WorkspaceCancellation, WorkspaceOperationCancelled};
use crate::test_support::temp_workspace;
use tempfile::tempdir;

static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

#[tokio::test]
async fn replaces_file_with_240_character_name() {
    let workspace = tempdir().unwrap();
    let name = "a".repeat(240);
    let target = workspace.path().join(&name);
    fs::write(&target, "before\n").unwrap();
    let patch =
        format!("*** Begin Patch\n*** Update File: {name}\n@@\n-before\n+after\n*** End Patch");

    apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        &patch,
    )
    .await
    .expect("long filename should not be extended for staging");

    assert_eq!(fs::read_to_string(target).unwrap(), "after\n");
}

#[tokio::test]
async fn leaves_legacy_staging_siblings_untouched() {
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("file.txt");
    let legacy_tmp = workspace.path().join("file.txt.sprocket-tmp.1.2.3");
    let legacy_bak = workspace.path().join("file.txt.sprocket-bak.1.2.3");
    fs::write(&target, "before\n").unwrap();
    fs::write(&legacy_tmp, "user tmp\n").unwrap();
    fs::write(&legacy_bak, "user bak\n").unwrap();

    apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .await
    .expect("replacement should succeed");

    assert_eq!(fs::read_to_string(target).unwrap(), "after\n");
    assert_eq!(fs::read_to_string(legacy_tmp).unwrap(), "user tmp\n");
    assert_eq!(fs::read_to_string(legacy_bak).unwrap(), "user bak\n");
    assert_eq!(fs::read_dir(workspace.path()).unwrap().count(), 3);
}

#[cfg(unix)]
#[tokio::test]
async fn replaces_file_in_unlistable_parent_directory() {
    use std::os::unix::fs::PermissionsExt;

    if unsafe { libc::geteuid() } == 0 {
        return;
    }

    let workspace = tempdir().unwrap();
    let target = workspace.path().join("file.txt");
    fs::write(&target, "before\n").unwrap();
    let original_mode = fs::metadata(workspace.path()).unwrap().permissions().mode();
    fs::set_permissions(workspace.path(), fs::Permissions::from_mode(0o300)).unwrap();

    let result = apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .await;
    fs::set_permissions(workspace.path(), fs::Permissions::from_mode(original_mode)).unwrap();

    result.expect("replacement should not require listing the parent");
    assert_eq!(fs::read_to_string(target).unwrap(), "after\n");
}

#[cfg(unix)]
#[tokio::test]
async fn preserves_executable_mode_when_replacing_file() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = tempdir().unwrap();
    let target = workspace.path().join("script.sh");
    fs::write(&target, "#!/bin/sh\nexit 1\n").unwrap();
    let original_mode = fs::metadata(&target).unwrap().permissions().mode();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o751)).unwrap();

    let result = apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: script.sh\n@@\n-#!/bin/sh\n-exit 1\n+#!/bin/sh\n+exit 0\n*** End Patch",
    )
    .await;
    let resulting_mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
    fs::set_permissions(&target, fs::Permissions::from_mode(original_mode)).unwrap();

    result.expect("executable should be replaced");
    assert_eq!(resulting_mode, 0o751);
}

#[cfg(unix)]
#[tokio::test]
async fn staging_allocation_failure_preserves_original() {
    use std::os::unix::fs::PermissionsExt;

    if unsafe { libc::geteuid() } == 0 {
        return;
    }

    let workspace = tempdir().unwrap();
    let target = workspace.path().join("file.txt");
    fs::write(&target, "before\n").unwrap();
    let original_mode = fs::metadata(workspace.path()).unwrap().permissions().mode();
    fs::set_permissions(workspace.path(), fs::Permissions::from_mode(0o500)).unwrap();

    let result = apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .await;
    fs::set_permissions(workspace.path(), fs::Permissions::from_mode(original_mode)).unwrap();

    result.expect_err("staging should fail in a non-writable parent");
    assert_eq!(fs::read_to_string(target).unwrap(), "before\n");
    assert_eq!(fs::read_dir(workspace.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn partial_staged_write_preserves_original() {
    use std::os::unix::process::CommandExt;

    const WORKSPACE_ENV: &str = "SPROCKET_PATCH_WRITE_FAILURE_TEST";
    if let Some(root) = std::env::var_os(WORKSPACE_ENV) {
        let root = std::path::PathBuf::from(root);
        let target = root.join("file.txt");
        let permissions = fs::metadata(&target).unwrap().permissions();
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(super::replace_file(&target, &[b'x'; 4096], permissions))
            .expect_err("replacement must exceed the child process file-size limit");

        assert!(error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.raw_os_error() == Some(libc::EFBIG))
        }));
        assert_eq!(fs::read_to_string(target).unwrap(), "original\n");
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
        return;
    }

    let workspace = tempdir().unwrap();
    fs::write(workspace.path().join("file.txt"), "original\n").unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "patch::tests::partial_staged_write_preserves_original",
        ])
        .env(WORKSPACE_ENV, workspace.path());
    // Restrict only the child so parallel tests keep their normal limits.
    unsafe {
        child.pre_exec(|| {
            if libc::signal(libc::SIGXFSZ, libc::SIG_IGN) == libc::SIG_ERR {
                return Err(std::io::Error::last_os_error());
            }
            let limit = libc::rlimit {
                rlim_cur: 1024,
                rlim_max: 1024,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn rollback_restores_deleted_file_and_removes_created_file() {
    let workspace = tempdir().unwrap();
    let deleted = workspace.path().join("deleted.txt");
    let created = workspace.path().join("created.txt");
    fs::write(&deleted, "original\n").unwrap();
    let permissions = fs::metadata(&deleted).unwrap().permissions();
    let snapshot = PatchSnapshot {
        files: BTreeMap::from([
            (
                deleted.clone(),
                Some(FileSnapshot {
                    contents: b"original\n".to_vec(),
                    permissions,
                }),
            ),
            (created.clone(), None),
        ]),
        missing_directories: Vec::new(),
    };
    fs::remove_file(&deleted).unwrap();
    fs::write(&created, "partial change\n").unwrap();

    restore_snapshot(&snapshot)
        .await
        .expect("rollback should restore the snapshot");

    assert_eq!(fs::read_to_string(deleted).unwrap(), "original\n");
    assert!(!created.exists());
}

#[cfg(windows)]
fn directory_entries(path: &std::path::Path) -> std::collections::BTreeSet<std::ffi::OsString> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect()
}

#[cfg(windows)]
#[tokio::test]
async fn windows_native_rename_replaces_existing_file_and_cleans_up() {
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("file.txt");
    fs::write(&target, "before\n").unwrap();
    let entries_before = directory_entries(workspace.path());

    apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .await
    .expect("native rename should replace an existing file");

    assert_eq!(fs::read_to_string(target).unwrap(), "after\n");
    assert_eq!(directory_entries(workspace.path()), entries_before);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_locked_target_is_preserved_and_staging_is_cleaned_up() {
    use std::os::windows::fs::OpenOptionsExt;

    let workspace = tempdir().unwrap();
    let target = workspace.path().join("file.txt");
    fs::write(&target, "before\n").unwrap();
    let entries_before = directory_entries(workspace.path());
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&target)
        .unwrap();

    let result = apply_workspace_patch(
        workspace.path().to_owned(),
        WorkspaceCancellation::new(),
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .await;

    result.expect_err("rename should fail while the target denies delete sharing");
    assert_eq!(fs::read_to_string(&target).unwrap(), "before\n");
    assert_eq!(directory_entries(workspace.path()), entries_before);
    drop(lock);
}

#[tokio::test]
async fn applies_begin_patch_format() {
    let root = temp_workspace();
    fs::write(root.join("source.txt"), "before\n").unwrap();
    fs::write(root.join("delete.txt"), "delete me\n").unwrap();
    let patch = "*** Begin Patch\n\
            *** Add File: created.txt\n\
            +created\n\
            *** Delete File: delete.txt\n\
            *** Update File: source.txt\n\
            *** Move to: moved.txt\n\
            @@\n\
            -before\n\
            +after\n\
            *** End Patch";

    let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("apply_patch format should apply");

    assert_eq!(output.changes.len(), 3);
    assert!(output.changes[0].source.is_none());
    assert!(output.changes[1].source.is_none());
    assert_eq!(output.changes[2].source.as_deref(), Some("source.txt"));
    assert_eq!(
        fs::read_to_string(root.join("created.txt")).unwrap(),
        "created\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("moved.txt")).unwrap(),
        "after\n"
    );
    assert!(!root.join("source.txt").exists());
    assert!(!root.join("delete.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn copies_and_renames_with_begin_patch() {
    let root = temp_workspace();
    fs::write(root.join("src.txt"), "shared\n").unwrap();
    fs::write(root.join("old.txt"), "keep\n").unwrap();
    let patch = "*** Begin Patch\n\
            *** Copy File: src.txt\n\
            *** Copy to: dest.txt\n\
            @@\n\
            -shared\n\
            +copied\n\
            *** Update File: old.txt\n\
            *** Move to: renamed.txt\n\
            *** End Patch";

    let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("copy/rename envelope should apply");

    assert_eq!(output.changes.len(), 2);
    assert_eq!(output.changes[0].path, "dest.txt");
    assert_eq!(output.changes[0].source.as_deref(), Some("src.txt"));
    assert_eq!(output.changes[1].path, "renamed.txt");
    assert_eq!(output.changes[1].source.as_deref(), Some("old.txt"));
    assert_eq!(
        fs::read_to_string(root.join("src.txt")).unwrap(),
        "shared\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("dest.txt")).unwrap(),
        "copied\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("renamed.txt")).unwrap(),
        "keep\n"
    );
    assert!(!root.join("old.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_unified_diff_without_git_header() {
    let root = temp_workspace();
    fs::write(root.join("file.txt"), "before\n").unwrap();
    let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("unified diff should apply");

    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "after\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn strips_ab_prefixes_from_header_only_unified_diff() {
    let root = temp_workspace();
    fs::write(root.join("file.txt"), "before\n").unwrap();
    let patch = "--- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("a/b unified diff should apply");

    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "after\n"
    );
    assert!(!root.join("a").exists());
    assert!(!root.join("b").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_multi_file_patch() {
    let root = temp_workspace();
    fs::write(root.join("modify.txt"), "before\n").unwrap();
    fs::write(root.join("delete.txt"), "delete me\n").unwrap();
    let patch = "diff --git a/modify.txt b/modify.txt\n\
            --- a/modify.txt\n\
            +++ b/modify.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n\
            diff --git a/create.txt b/create.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/create.txt\n\
            @@ -0,0 +1 @@\n\
            +created\n\
            diff --git a/delete.txt b/delete.txt\n\
            deleted file mode 100644\n\
            --- a/delete.txt\n\
            +++ /dev/null\n\
            @@ -1 +0,0 @@\n\
            -delete me\n";

    let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("patch should apply");

    assert_eq!(output.changes.len(), 3);
    assert_eq!(
        fs::read_to_string(root.join("modify.txt")).unwrap(),
        "after\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("create.txt")).unwrap(),
        "created\n"
    );
    assert!(!root.join("delete.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_hunks_while_renaming() {
    let root = temp_workspace();
    fs::write(root.join("old.txt"), "before\n").unwrap();
    let patch = "diff --git a/old.txt b/new.txt\n\
            similarity index 50%\n\
            rename from old.txt\n\
            rename to new.txt\n\
            --- a/old.txt\n\
            +++ b/new.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("rename patch should apply");

    assert!(!root.join("old.txt").exists());
    assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "after\n");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_header_only_delete() {
    let root = temp_workspace();
    fs::write(root.join("delete.txt"), "content\n").unwrap();
    let patch = "diff --git a/delete.txt b/delete.txt\n\
            deleted file mode 100644\n\
            index 1111111..0000000\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("header-only delete should apply");

    assert!(!root.join("delete.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn copies_one_source_to_multiple_files() {
    let root = temp_workspace();
    fs::write(root.join("source.txt"), "content\n").unwrap();
    let patch = "diff --git a/source.txt b/first.txt\n\
            similarity index 100%\n\
            copy from source.txt\n\
            copy to first.txt\n\
            diff --git a/source.txt b/second.txt\n\
            similarity index 100%\n\
            copy from source.txt\n\
            copy to second.txt\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("copy patch should apply");

    assert_eq!(
        fs::read_to_string(root.join("source.txt")).unwrap(),
        "content\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("first.txt")).unwrap(),
        "content\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("second.txt")).unwrap(),
        "content\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn serializes_overlapping_patches() {
    let root = temp_workspace();
    let contents = format!("before\n{}", "padding\n".repeat(100_000));
    fs::write(root.join("file.txt"), contents).unwrap();
    let first_patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +first\n";
    let second_patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +second\n";

    let (first, second) = tokio::join!(
        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), first_patch),
        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), second_patch)
    );

    assert_ne!(first.is_ok(), second.is_ok());
    let final_contents = fs::read_to_string(root.join("file.txt")).unwrap();
    assert!(final_contents.starts_with("first\n") || final_contents.starts_with("second\n"));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_dangling_symlink_destination() {
    use std::os::unix::fs::symlink;

    let root = temp_workspace();
    symlink("../outside.txt", root.join("created.txt")).unwrap();
    let patch = "diff --git a/created.txt b/created.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/created.txt\n\
            @@ -0,0 +1 @@\n\
            +content\n";

    let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect_err("dangling symlink should be rejected");

    assert!(error.to_string().contains("destination already exists"));
    assert!(!root.parent().unwrap().join("outside.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn writes_through_symlink_outside_workspace() {
    use std::os::unix::fs::symlink;

    use super::write_new_file;

    let root = temp_workspace();
    let outside = temp_workspace();
    fs::create_dir(root.join("nested")).unwrap();
    fs::rename(root.join("nested"), root.join("moved")).unwrap();
    symlink(&outside, root.join("nested")).unwrap();

    write_new_file(&root.join("nested/escaped.txt"), b"escaped\n", None)
        .await
        .expect("writes through symlink outside the workspace should succeed");

    assert_eq!(
        fs::read_to_string(outside.join("escaped.txt")).unwrap(),
        "escaped\n"
    );
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn applies_patch_outside_workspace_root() {
    let root = temp_workspace();
    let outside = temp_workspace();
    fs::write(outside.join("outside.txt"), "before\n").unwrap();
    let outside_file = outside.join("outside.txt");
    let patch = format!(
        "*** Begin Patch\n\
            *** Update File: {}\n\
            @@\n\
            -before\n\
            +after\n\
            *** End Patch",
        outside_file.display()
    );

    let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), &patch)
        .await
        .expect("patch outside the workspace root should apply");

    assert_eq!(output.changes.len(), 1);
    assert_eq!(
        output.changes[0].path,
        outside_file.to_string_lossy().replace('\\', "/")
    );
    assert_eq!(fs::read_to_string(&outside_file).unwrap(), "after\n");
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn cancelled_patch_does_not_mutate_files() {
    let root = temp_workspace();
    fs::write(root.join("file.txt"), "before\n").unwrap();
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

    let error = apply_workspace_patch(root.clone(), cancellation, patch)
        .await
        .expect_err("cancelled patch should fail");

    assert!(error.is::<WorkspaceOperationCancelled>());
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "before\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_all_lines_when_hunk_count_under_declared() {
    let root = temp_workspace();
    // Declares 2 added lines but body has 3. Previously truncated silently.
    let patch = "diff --git a/file.txt b/file.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/file.txt\n\
            @@ -0,0 +1,2 @@\n\
            +one\n\
            +two\n\
            +three\n";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("under-declared hunk counts should be corrected");

    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "one\ntwo\nthree\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rejects_orphaned_hunk_body_after_junk() {
    let root = temp_workspace();
    let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n\
            not-a-hunk-line\n\
            +orphaned\n";
    fs::write(root.join("file.txt"), "before\n").unwrap();

    let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect_err("orphaned hunk lines must not be ignored");

    assert!(
        error.to_string().contains("unexpected hunk body line"),
        "unexpected error: {error:#}"
    );
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "before\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rejects_create_hunk_body_without_plus_prefixes() {
    let root = temp_workspace();
    let patch = "--- /dev/null\n\
            +++ file.txt\n\
            @@ -0,0 +1 @@\n\
            hello\n";

    let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect_err("create body without + prefixes must fail");

    assert!(
        error.to_string().contains("unexpected hunk body line"),
        "unexpected error: {error:#}"
    );
    assert!(!root.join("file.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rejects_update_hunk_body_that_is_only_junk() {
    let root = temp_workspace();
    fs::write(root.join("file.txt"), "before\n").unwrap();
    let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            this is junk\n";

    let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect_err("junk-only update body must fail");

    assert!(
        error.to_string().contains("unexpected hunk body line"),
        "unexpected error: {error:#}"
    );
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "before\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_non_ascii_content_via_begin_patch_and_unified_diff() {
    let root = temp_workspace();
    fs::write(root.join("existing.txt"), "café\n").unwrap();

    let begin_patch = "*** Begin Patch\n\
            *** Add File: unicode.txt\n\
            +こんにちは\n\
            *** Update File: existing.txt\n\
            @@\n\
            -café\n\
            +café crème\n\
            *** End Patch";
    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), begin_patch)
        .await
        .expect("Begin Patch with non-ASCII should apply");
    assert_eq!(
        fs::read_to_string(root.join("unicode.txt")).unwrap(),
        "こんにちは\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("existing.txt")).unwrap(),
        "café crème\n"
    );

    let unified = "--- existing.txt\n\
            +++ existing.txt\n\
            @@ -1 +1 @@\n\
            -café crème\n\
            +naïve résumé\n";
    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), unified)
        .await
        .expect("unified diff with non-ASCII should apply");
    assert_eq!(
        fs::read_to_string(root.join("existing.txt")).unwrap(),
        "naïve résumé\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn applies_begin_patch_inside_markdown_fence() {
    let root = temp_workspace();
    let patch = "```\n\
            *** Begin Patch\n\
            *** Add File: fenced.txt\n\
            +hello\n\
            *** End Patch\n\
            ```";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("fenced Begin Patch should apply");

    assert_eq!(
        fs::read_to_string(root.join("fenced.txt")).unwrap(),
        "hello\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn preserves_trailing_whitespace_in_fenced_unified_diff() {
    let root = temp_workspace();
    // Last hunk line ends with two spaces and a tab; it must survive fence stripping.
    let patch = "```diff\n\
            --- /dev/null\n\
            +++ spaced.txt\n\
            @@ -0,0 +1 @@\n\
            +final  \t\n\
            ```";

    apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
        .await
        .expect("fenced unified diff should apply");

    assert_eq!(fs::read(root.join("spaced.txt")).unwrap(), b"final  \t\n");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn expands_home_prefix_in_patch_paths() {
    let _guard = HOME_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_workspace();
    let home = temp_workspace();
    let previous_home = std::env::var_os("HOME");
    // SAFETY: serialized by HOME_ENV_LOCK for this test only.
    unsafe {
        std::env::set_var("HOME", &home);
    }

    let patch = "*** Begin Patch\n\
            *** Add File: ~/from-home.txt\n\
            +home-relative\n\
            *** End Patch";
    let result = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch).await;

    match previous_home {
        Some(value) => unsafe { std::env::set_var("HOME", value) },
        None => unsafe { std::env::remove_var("HOME") },
    }

    result.expect("~/ paths should resolve under $HOME");
    assert_eq!(
        fs::read_to_string(home.join("from-home.txt")).unwrap(),
        "home-relative\n"
    );
    assert!(!root.join("~/from-home.txt").exists());
    assert!(!root.join("from-home.txt").exists());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(home).unwrap();
}
