# Agent input

An agent can stop and ask the user something. A question from `ask_question` takes over the composer until the user answers or skips it, and the thread's inbox row reads `Needs input`. A purchase an agent starts with Agentcard shows an approval notice above the prompt.

## Sub-features

- `question-show` shows the question and its options in the composer and marks the row `Needs input`.
- `question-answer` sends a picked option, typed text, or both.
- `question-skip` skips the question.
- `question-collapse` collapses the question to its first line and expands it again.
- `purchase-approve` shows `Approve <amount> at <merchant>` with an `Approve` button that opens the Agentcard popup.

## How to get to it (user POV)

- Ask the agent something that makes it call `ask_question`. The question appears in that thread's composer.
- Open a thread whose row reads `Needs input` from `Unsettled`.

## Driving it with agent-browser

Precondition: an open thread, and the dev `tiers` table has rows, as in [threads.md](./threads.md). Run every step in that one thread.

- **Ask.** Send `Use ask_question to ask me "Pick one" with options A and B, then reply with my answer.` Poll plain `snapshot` until `group "Agent question"` appears, within about 30 s. It holds the text `Pick one`, `button "Collapse question" [expanded=true]` and `list "Answer options"` with `button "A"`, `button "B"` and `button "Let me (the agent) decide"`. The combobox is renamed `combobox "Add detail, or type a custom answer"`, `button "Skip question"` replaces `Send message`, and `button "Attach files"` and `button "Select model"` are `[disabled]`.
- **Inbox.** The thread's `group` in `region "Unsettled"` shows `Needs input` next to the project name.
- **Answer.** Click `button "A"`. Its `aria-pressed` is `true` and `button "Send answer"` replaces `Skip question`. Click `Send answer`. The question leaves the composer, the row drops `Needs input`, `Conversation history` shows `button "Asked 1 question" [expanded=false]`, and the reply names A.
- **Skip.** Send `Ask the same question again with ask_question, then reply skipped if I skip it.` and click `button "Skip question"`. The question leaves the composer and the reply is `skipped`.
- **Collapse.** Ask once more. Click `button "Collapse question"`. The group shows only the question text and `button "Expand question" [expanded=false]`. Click it and the options return. Skip it to finish the run.

## Gotchas

- Each ask costs model quota and a full run. Keep the three asks short.
- A question that is still pending when its run ends starts collapsed.
- `purchase-approve` is unreachable on dev. It needs a pending Agentcard purchase from `card_checkout`, and billing and checkout fail on dev (Known limits in `SKILL.md`). `purchase-approvals.tsx` renders it as a `status` in the composer's `region "Conversation notices"`.
