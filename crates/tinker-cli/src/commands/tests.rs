use super::*;

#[test]
fn deadlines_are_positive_bounded_and_overflow_checked() {
    assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
    for value in ["0", "-1", "1.5s", "1d", "18446744073709551615h"] {
        assert!(parse_duration(value).is_err(), "{value}");
    }
}
