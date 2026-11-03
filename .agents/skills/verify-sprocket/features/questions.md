# Questions

While a run is live, the agent can ask a multiple-choice question. The question sits in the transcript and in the composer. Skip or send an answer; the question collapses when the run ends.

## Sub-features

- `question-ask` shows an expanded question with options while the run waits.
- `question-answer` selects an option and sends it with `Send answer`.
- `question-skip` skips without choosing an option.
- `question-collapse` collapses the question when the run ends.

## How to get to it (user POV)

- Send a prompt that uses the `ask_question` tool, for example `Use the ask_question tool to ask me which color I prefer, with options red and blue. Do not reply otherwise.`

## Driving it with agent-browser

Precondition: a thread is open, as in [threads.md](./threads.md). `tiers` has rows.

- **Ask.** After send, `Conversation history` shows `button "Asked 1 question" [expanded=true]` and `group "Agent question"`. `snapshot -i` lists the title `button "<question>" [expanded=true]`, one button per option, and `button "Let me (the agent) decide"`. The composer placeholder becomes `combobox "Add detail, or type a custom answer"`. `button "Skip question"` replaces `Stop generation`. The inbox row shows `Working`.
- **Answer.** Click an option, for example `button "Red"`. `button "Send answer"` replaces `Skip question`. Click it. The run continues; `Stop generation` returns.
- **Skip.** On a pending question with no option selected, click `button "Skip question"`. `Stop generation` returns and the run continues.
- **Collapse.** When the run ends, `Asked 1 question` is `[expanded=false]` and the option buttons are gone from `snapshot -i`. The composer is `Ask anything, use / for commands, @ to tag files/folders, and $ for skills` again.

## Gotchas

- A pending question replaces `Stop generation`. Do not wait for Stop while `Skip question` or `Send answer` is showing.
- `Let me (the agent) decide` is always an extra option. It is reserved; the agent's own options keep their labels.
- `snapshot -i` may omit `aria-pressed` on the selected option. `Send answer` appearing is the check that a choice landed.
- Same quota and `@`/`$`/`/` popups as in [threads.md](./threads.md).
