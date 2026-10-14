use super::normalize_unified_diff_hunk_counts;

#[test]
fn normalize_rewrites_under_and_over_declared_hunk_lengths() {
    let under = "\
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,2 @@
 keep
-old
+new
+extra
";
    let under_normalized = normalize_unified_diff_hunk_counts(under).expect("normalize");
    assert!(under_normalized.contains("@@ -1,2 +1,3 @@"));
    assert!(under_normalized.contains("+extra\n"));

    let over = "\
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,5 @@
+one
+two
";
    let over_normalized = normalize_unified_diff_hunk_counts(over).expect("normalize");
    assert!(over_normalized.contains("@@ -0,0 +1,2 @@"));
}
