use super::*;

fn first_item(src: &str, check: impl Fn(Expr)) {
    let mut seen = false;
    for_each_item(src, "kicad_pcb", |item| {
        check(item);
        seen = true;
        Ok(())
    })
    .unwrap();
    assert!(seen);
}

#[test]
fn reads_escaped_strings_and_flag_forms() {
    let src = r#"(kicad_pcb 20241229 (fp_text user "a \"b\"\nc" hide (unlocked) (locked no) (at 1 -2.5)))"#;
    first_item(src, |item| {
        assert_eq!(item.head(), Some("fp_text"));
        assert_eq!(item.text_arg(1).as_deref(), Some("a \"b\"\nc"));
        assert!(item.flag("hide"));
        assert!(item.flag("unlocked"));
        assert!(!item.flag("locked"));
        assert_eq!(item.child("at").and_then(|at| at.number_arg(1)), Some(-2.5));
    });
}

#[test]
fn rejects_unclosed_files() {
    let error = for_each_item("(kicad_pcb (net 1 \"a\")", "kicad_pcb", |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("ends before"));
}
