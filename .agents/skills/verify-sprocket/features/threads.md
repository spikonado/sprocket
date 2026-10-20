# Threads

The user sends a prompt in a project. The local agent runs it through the model gateway, the reply streams into the transcript, and the thread appears in the sidebar with a generated title.

## Sub-features

- `thread-start` sends the first prompt from the composer.
- `thread-reply` streams a model reply and finishes the run.
- `thread-stop` stops a running agent from the composer.
- `thread-inbox` lists the thread under `Unsettled` and reopens it.
- `thread-rename` renames the thread from its sidebar row.
- `thread-settle` moves the thread to `Settled Threads` and back.
- `thread-persist` shows the same transcript after a reload or a server restart.

## How to get to it (user POV)

- Choose `New thread` in the sidebar, or use the composer on the start screen with a project selected.
- Reopen a thread from the `Unsettled` region of the sidebar.

## Driving it with agent-browser

Precondition: the dev deployment's `tiers` table has rows. See Known limits in `SKILL.md`.

- **Type prompt.** Click `combobox "Ask anything, use / for commands, @ to tag files/folders, and $ for skills"` and run `agent-browser keyboard type "Reply with the single word ok"`. `button "Send message"` becomes enabled.
- **Send.** Click `button "Send message"`. Plain `snapshot` first shows the composer status `Sending request…` with the composer disabled, then the prompt and its `button "Copy message"` in `region "Conversation history"`. While the run is live, that snapshot shows `Agent is running` and `button "Stop generation"` in place of `Send message`. `region "Unsettled"` has a new `group` whose accessible name is the title (the prompt text until the generated title arrives, which can happen before the reply). `Starting`, then `Working`, is a separate status badge in the row, not the group name.
- **Reply.** Within about 30 s, `Agent is running` is gone and `Conversation history` holds a paragraph `ok` after the prompt.
- **Inbox.** The row's `group` and `button` now carry the generated title, for example `Single-Word Reply Request`, next to the project name, with no `Working` or `Failed` label.
- **Stop.** Send `Run the shell command sleep 20, then reply done`. Poll `$V/ref.sh 'button "Stop generation"'` until it prints a ref, then click it. In-progress work is a collapsed disclosure and often does not expose `Ran 1 command` in snapshot, so do not wait on that string. `Agent is running` goes away, `button "Continue working"` appears, and the launch log shows `sprocket-agent: run cancelled <run id>`.
- **Rename.** `agent-browser dblclick` the row's title button. `textbox "Rename thread"` appears. `agent-browser press Control+a`, type `verify rename`, and press Enter. The row is `button "verify rename"`.
- **Settle.** Hover the row, then click `button "Settle verify rename"`. Settle is disabled while the row still shows `Starting` or `Working`. The row leaves `Unsettled` and `region "Settled Threads"` is already expanded. An extra click on `button "Settled Threads"` collapses it. Hover the row there and click `button "Unsettle verify rename"`. It returns to `Unsettled`.
- **Persist.** Reload or restart the server, then reopen the thread from `Unsettled`. Both the prompt and the reply show.
- **Side effect.** The launch log shows `sprocket-agent: model completed <run id>` and then `sprocket-agent: mutation done agentRuntime:finalizeExecutorRun`.

## Gotchas

- `@`, `$` and `/` in the composer open popups that capture Enter. Plain-text prompts avoid them.
- Each prompt uses real model quota on the user's dev account. Keep prompts tiny.
- `button "Copy message"` belongs to the prompt, so it proves nothing about the reply.
- A plain-text reply finishes before a click on `Stop generation` lands. The stop recipe needs a tool call to keep the run alive.
- Stopping leaves the started command running under `Running commands` until it exits on its own.
- The `Settle` and `Unsettle` buttons are in the row always, but CSS shows them only on `:hover`. Hover with `mouse move` on the title's box before clicking; `snapshot -i` lists them once the row is hovered. They are not shown on focus.
