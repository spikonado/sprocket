# Agent input

An agent can stop and ask the user something. A question from `ask_question` appears above the message draft, and the thread's inbox row reads `Needs input`. A purchase an agent starts with Agentcard shows an approval notice above the prompt.

## Sub-features

- `question-show` shows the question and its options in the composer and marks the row `Needs input`.
- `question-answer` sends a picked option, typed text, or both.
- `question-skip` skips the question.
- `question-collapse` collapses the question to its first line and expands it again.
- `purchase-approve` shows `Approve <amount> at <merchant>` with an `Approve` button that opens a dialog with the approval link's QR code and `Open on this computer`.

## How to get to it (user POV)

- Ask the agent something that makes it call `ask_question`. The question appears in that thread's composer.
- Open a thread whose row reads `Needs input` from `Unsettled`.

## Driving it with agent-browser

Precondition: an open thread, and the dev `tiers` table has rows, as in [threads.md](./threads.md). Run every step in that one thread.

- **Ask.** Send `Use ask_question to ask me "Pick one" with options A and B, then reply with my answer.` Before it appears, type a follow-up in the message composer. Wait for `group "Agent question"`. It shows `Pick one`, the options, an empty `textbox "Answer to agent question"`, and `Skip question`. Verify the follow-up stays in the message composer.
- **Inbox.** The thread's `group` in `region "Unsettled"` shows `Needs input` next to the project name.
- **Answer.** Click `button "A"`. Its `aria-pressed` is `true` and `button "Send answer"` replaces `Skip question`. Click `Send answer`. The question leaves the composer, the row drops `Needs input`, `Conversation history` shows `button "Asked 1 question" [expanded=false]`, and the reply names A. Verify the follow-up is still in the composer.
- **Skip.** Send `Ask the same question again with ask_question, then reply skipped if I skip it.` and click `button "Skip question"`. The question leaves the composer and the reply is `skipped`.
- **Collapse.** Ask once more. Click `button "Collapse question"`. The options disappear. Click `button "Expand question"` and the options return. Skip it to finish the run.

## Gotchas

- Each ask costs model quota and a full run. Keep the three asks short.
- A question that is still pending when its run ends starts collapsed.
- `purchase-approve` is unreachable on dev. It needs a pending Agentcard purchase from `card_checkout`, and billing and checkout fail on dev (Known limits in `SKILL.md`).
