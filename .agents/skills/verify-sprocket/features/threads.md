# Threads

The user sends a prompt in a project. The local agent runs it through the model gateway, the reply streams into the transcript, and the thread appears in the sidebar with a generated title.

## Sub-features

- `thread-start` sends the first prompt from the composer.
- `thread-reply` streams a model reply and finishes the run.
- `thread-inbox` lists the thread under `Unsettled` and reopens it.
- `thread-persist` shows the same transcript after a reload or a server restart.

## How to get to it (user POV)

- Choose `New thread` in the sidebar, or use the composer on the start screen with a project selected.
- Reopen a thread from the `Unsettled` region of the sidebar.

## Driving it with agent-browser

Precondition: the dev deployment's `tiers` table is seeded (Known limits in `SKILL.md`).

- **Type prompt.** Click `combobox "Ask anything, use / for commands, @ to tag files/folders, and $ for skills"` and run `agent-browser keyboard type "Reply with the single word ok"`. `button "Send message"` becomes enabled.
- **Send.** Click `button "Send message"`. The prompt appears in `region "Conversation history"`.
- **Reply.** Within about 30 s, `Conversation history` holds a paragraph `ok` after the prompt and its `button "Copy message"`. `button "Send message"` is disabled again because the composer is empty.
- **Inbox.** `region "Unsettled"` lists a button with the generated title, for example `Single-Word OK Request`, under the project name, with no `Failed` label.
- **Persist.** Reload or restart the server, then reopen the thread from `Unsettled`. Both the prompt and the reply show.
- **Side effect.** The launch log shows `sprocket-agent: model completed <run id>` and `mutation done agentRuntime:finalizeExecutorRun`.

## Gotchas

- `@`, `$` and `/` in the composer open popups that capture Enter. Plain-text prompts avoid them.
- Each prompt uses real model quota on the user's dev account. Keep prompts tiny.
