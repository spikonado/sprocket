use super::super::questions::QuestionAnswer;
use super::*;

fn snapshot(status: &str, answer: Option<QuestionAnswer>) -> QuestionSnapshot {
    QuestionSnapshot {
        question_id: "q1".to_string(),
        status: status.to_string(),
        answer,
    }
}

fn option(id: &str) -> Option<QuestionAnswer> {
    Some(QuestionAnswer {
        option_id: Some(id.to_string()),
        ..QuestionAnswer::default()
    })
}

fn text(text: &str) -> Option<QuestionAnswer> {
    Some(QuestionAnswer {
        text: Some(text.to_string()),
        ..QuestionAnswer::default()
    })
}

#[test]
fn approvals_allow_only_the_allow_options_and_return_the_users_words() {
    let approval = |status, answer| approval_from_snapshot(&snapshot(status, answer)).unwrap();
    assert_eq!(approval("answered", option("allow")), Approval::Once);
    assert_eq!(approval("answered", option("always")), Approval::Always);
    assert_eq!(
        approval("answered", option("deny")),
        Approval::Denied { text: None }
    );
    assert_eq!(
        approval("answered", text("use the staging project")),
        Approval::Denied {
            text: Some("use the staging project".to_string())
        }
    );
    for status in ["skipped", "timedOut"] {
        assert_eq!(approval(status, None), Approval::Denied { text: None });
    }
    assert!(approval_from_snapshot(&snapshot("cancelled", None)).is_err());
}

#[test]
fn form_answers_map_to_elicitation_actions() {
    let mut values = JsonObject::new();
    values.insert("project".to_string(), json!("sprocket"));
    let filled = Some(QuestionAnswer {
        values: Some(values.clone()),
        ..QuestionAnswer::default()
    });
    assert_eq!(
        elicitation_from_snapshot(&snapshot("answered", filled)),
        (ElicitationOutcome::Accept(values), None)
    );
    assert_eq!(
        elicitation_from_snapshot(&snapshot("answered", text("not that one"))),
        (
            ElicitationOutcome::Decline,
            Some("not that one".to_string())
        )
    );
    assert_eq!(
        elicitation_from_snapshot(&snapshot("skipped", None)),
        (ElicitationOutcome::Decline, None)
    );
    for status in ["cancelled", "timedOut"] {
        assert_eq!(
            elicitation_from_snapshot(&snapshot(status, None)).0,
            ElicitationOutcome::Cancel
        );
    }
}
