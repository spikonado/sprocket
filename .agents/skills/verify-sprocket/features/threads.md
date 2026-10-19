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

Precondition: the dev deployment's `tiers` table is seeded. See Known limits in `SKILL.md`.

- **Type prompt.** Click `combobox "Ask anything, use / for commands, @ to tag files/folders, and $ for skills"` and run `agent-browser keyboard type "Reply with the single word ok"`. `button "Send message"` becomes enabled.
- **Send.** Click `button "Send message"`. The prompt and its `button "Copy message"` appear in `region "Conversation history"`. Plain `snapshot` shows the status `Agent is running`, and `region "Unsettled"` has a `group` named after the prompt text with a `Working` label.
- **Reply.** Within about 30 s, `Agent is running` is gone and `Conversation history` holds a paragraph `ok` after the prompt.
- **Inbox.** The row's `group` and `button` now carry the generated title, for example `Single-Word Reply Request`, next to the project name, with no `Working` or `Failed` label.
- **Persist.** Reload or restart the server, then reopen the thread from `Unsettled`. Both the prompt and the reply show.
- **Side effect.** The launch log shows `sprocket-agent: model completed <run id>` and then `sprocket-agent: mutation done agentRuntime:finalizeExecutorRun`.

## Gotchas

- `@`, `$` and `/` in the composer open popups that capture Enter. Plain-text prompts avoid them.
- Each prompt uses real model quota on the user's dev account. Keep prompts tiny.
- `button "Copy message"` belongs to the prompt, so it proves nothing about the reply.
