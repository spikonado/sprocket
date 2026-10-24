use crate::test_support::temp_workspace;

use super::*;

async fn render(body: &str, cwd: &Path, limits: SkillCommandLimits) -> String {
    render_skill_commands(body, cwd, &[], &WorkspaceCancellation::new(), limits)
        .await
        .expect("render")
}

#[test]
fn finds_placeholders_outside_code_blocks_and_code_spans() {
    let body = "\
!`one`
text !`two` and\t!`three`
KEY=!`not-after-whitespace`
`` !`double-backtick-example` ``
Use `ship !` and `format!` here, then !`` `double-span` ``.
```bash
!`fenced-backticks`
```
~~~
```
!`fenced-tildes`
~~~
````
```
!`inside-longer-fence`
````
  !`four`
`` multi-line
!`inside-multi-line-double-span` ``
` multi-line
!`inside-multi-line-single-span`
!`split
command`

`` unclosed before a blank line

!`five`
```
!`unclosed-fence`
";

    let placeholders = find_placeholders(body);
    let commands: Vec<_> = placeholders.iter().map(|found| found.command).collect();
    assert_eq!(commands, ["one", "two", "three", "four", "five"]);
    for found in &placeholders {
        assert_eq!(&body[found.range.clone()], format!("!`{}`", found.command));
    }
}

#[tokio::test]
async fn replaces_placeholders_with_output_run_in_the_given_directory() {
    let root = temp_workspace();
    std::fs::write(root.join("marker.txt"), "inside").unwrap();
    let rendered = render(
        "A: !`echo one`\nB: !`cat marker.txt` end\n",
        &root,
        SkillCommandLimits::DEFAULT,
    )
    .await;
    assert_eq!(rendered, "A: one\nB: inside end\n");
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn failures_become_inline_error_lines() {
    let root = temp_workspace();
    let rendered = render(
        "Status: !`echo oops; exit 3`",
        &root,
        SkillCommandLimits::DEFAULT,
    )
    .await;
    assert_eq!(
        rendered,
        "Status: [skill command failed: exit code 3: oops]"
    );

    let missing = root.join("missing");
    let rendered = render("!`echo hi`", &missing, SkillCommandLimits::DEFAULT).await;
    assert!(
        rendered.starts_with("[skill command failed: could not start shell"),
        "{rendered}"
    );
    std::fs::remove_dir_all(root).ok();
}

const WRITES_MARKERS_LATER: &str = "!`(sleep 1; touch child) & sleep 1; touch parent`";

async fn assert_no_markers_appear(root: &Path) {
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(!root.join("parent").exists(), "the shell kept running");
    assert!(!root.join("child").exists(), "a descendant kept running");
}

#[tokio::test]
async fn timeouts_stop_the_command_and_its_descendants_and_skip_the_rest() {
    let root = temp_workspace();
    let limits = SkillCommandLimits {
        command_timeout: Duration::from_millis(300),
        total_timeout: Duration::from_millis(300),
        ..SkillCommandLimits::DEFAULT
    };
    let rendered = render(
        &format!("{WRITES_MARKERS_LATER}\n!`echo late`"),
        &root,
        limits,
    )
    .await;
    assert_eq!(
        rendered,
        "[skill command failed: timed out after 0.3s]\n\
         [skill command skipped: skill commands used their 0.3s total time limit]"
    );
    assert_no_markers_appear(&root).await;
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn cancellation_stops_the_command_and_its_descendants() {
    let root = temp_workspace();
    let cancellation = WorkspaceCancellation::new();
    let canceller = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        canceller.cancel();
    });
    let error = render_skill_commands(
        WRITES_MARKERS_LATER,
        &root,
        &[],
        &cancellation,
        SkillCommandLimits::DEFAULT,
    )
    .await
    .expect_err("cancelled render");
    assert!(error.is::<WorkspaceOperationCancelled>(), "{error:#}");
    assert_no_markers_appear(&root).await;
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn caps_output_with_a_truncation_marker() {
    let root = temp_workspace();
    let limits = SkillCommandLimits {
        max_output_bytes: 5,
        ..SkillCommandLimits::DEFAULT
    };
    let rendered = render("!`echo hello world`", &root, limits).await;
    assert!(
        rendered.starts_with("hello\n[output truncated: showing the first 5 of "),
        "{rendered}"
    );
    std::fs::remove_dir_all(root).ok();
}
