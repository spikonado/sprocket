pub fn limit_chars(contents: &str, max_chars: usize) -> (String, bool) {
    let mut output = String::new();
    let mut count = 0;

    for character in contents.chars() {
        if count == max_chars {
            output.push_str("\n\n...[truncated]");
            return (output, true);
        }

        output.push(character);
        count += 1;
    }

    (output, false)
}
