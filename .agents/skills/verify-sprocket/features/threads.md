# Threads

The user sends a prompt in a project. The local agent runs it through the model gateway, the reply streams into the transcript, and the thread appears in the sidebar with a generated title.

## Sub-features

- `thread-start` sends the first prompt from the composer.
- `thread-reply` streams a model reply and finishes the run.
- `thread-stop` stops a running agent from the composer.
- `thread-inbox` lists the thread under `Unsettled` and reopens it.
- `thread-rename` renames the thread from its sidebar row.
- `thread-settle` moves the thread to `Settled Threads` and back.
- `thread-move` moves a root thread and its subagents to another project.
- `thread-persist` shows the same transcript after a reload or a server restart.
- `thread-usage` shows token usage under each finished run and in the composer's `AI usage` popover.
- `thread-prs` shows the pull requests an agent linked with `link_prs` on the thread's inbox row.

## How to get to it (user POV)

- Choose `New thread` in the sidebar, or use the composer on the start screen with a project selected.
- Reopen a thread from the `Unsettled` region of the sidebar.

## Driving it with agent-browser

Precondition: the dev deployment's `tiers` table has rows. See Known limits in `SKILL.md`.

- **Type prompt.** Click `combobox "Ask anything, use / for commands, @ to tag files/folders, and $ for skills"` and run `agent-browser keyboard type "Reply with the single word ok"`. `button "Send message"` becomes enabled.
- **Send.** Click `button "Send message"`. Plain `snapshot` first shows the composer status `Sending request…`, then the prompt in `region "Conversation history"`. On an existing thread, the status becomes `Starting agent…` before the run is live; a first send from New thread can skip it. While the run is live, plain `snapshot` shows the sr-only `Agent is running` and `button "Stop generation"` in place of `Send message`. `region "Unsettled"` has a new `group` named after the prompt text until the generated title arrives, which can happen before the reply. `Starting`, then `Working`, is a separate status badge in the row, not part of the group name.
- **Reply.** Within about 30 s, `Agent is running` is gone and `Conversation history` holds a paragraph `ok` after the prompt. Rich blocks in replies are in [transcript.md](./transcript.md).
- **Inbox.** The row's `group` and `button` now carry the generated title next to the project name, with no `Working` or `Failed` label.
- **Stop.** Send `Run the shell command sleep 20, then reply done` on an existing thread so `Starting agent…` is observable. Poll `$V/ref.sh 'button "Stop generation"'` until it prints a ref. While the run is live, the work disclosure `button "Ran 1 command" [expanded=true]` shows the `sleep 20` row. Click Stop. The work disclosure collapses to `[expanded=false]`, `Agent is running` goes away, `button "Continue working"` appears, and the launch log shows `sprocket-agent: run cancelled <run id>`.
- **Rename.** `agent-browser dblclick` the row's title button. `textbox "Rename thread"` appears. `agent-browser press Control+a`, type `verify rename`, and press Enter. The row is `button "verify rename"`.
- **Settle.** Right-click the title button as in Drive in `SKILL.md` and click `menuitem "Settle"`, which is disabled while the row shows `Starting` or `Working`. The row leaves `Unsettled`. Settling the open thread also returns to the new-thread heading. `region "Settled Threads"` keeps the open or closed state this browser stored, so click `button "Settled Threads"` only when it reads `[expanded=false]`; a click on an expanded heading collapses it. `snapshot -i` can omit the region while its rows are visible, so check the button's state rather than the region's absence. The settled row can sit below the fold. `agent-browser scrollintoview` that row, take a fresh `get box`, then right-click and choose `menuitem "Unsettle"`. It returns to `Unsettled`.
- **Persist.** Reload or restart the server, then reopen the thread from `Unsettled`. Both the prompt and the reply show.
- **Move.** Attach a second scratch repo with `$V/scratch-repo.sh /tmp/verify-move-target`. Right-click a finished root thread and click `menuitem "Move to project"`, which is disabled while the thread or its subagents are working. The menu swaps to `textbox "Search projects"` and the project buttons, with the current project pressed. Click `button "verify-move-target"`. The menu closes and the row's project label changes. An open thread also switches the composer's project. Filtering the inbox to the old project hides the row.
- **Usage.** After the reply, plain `snapshot` shows `<n> tokens`, `<n>% cached` and `API cost` under it. Click `button "AI usage"` in the composer, next to `Send message`. `dialog "AI usage"` shows `API cost`, `Tokens` with the same total, and the token types. `BY MODEL` appears only when the thread used more than one model. After a prompt such as `Spawn one subagent with the prompt Reply with the single word ok. Then reply done.`, the dialog has `group "Usage scope"` with `button "This thread"` and `button "With subagents (1)"`. The two totals differ by the subagent's row under `SUBAGENTS`.
- **Side effect.** The launch log shows `sprocket-agent: model completed <run id>` and then `sprocket-agent: mutation done agentRuntime:finalizeExecutorRun`.
- **Linked PRs.** Needs `switch "Use GitHub"` on, as in [settings.md](./settings.md). It is on by default; an empty `~/.sprocket-dev-verify/github-settings.json` means on. The first link comes from the one prompt in [transcript.md](./transcript.md). The row gains `link "Merged PR #1073: <title>"` to `https://github.com/spikonado/sprocket/pull/1073`, labeled `Open`, `Merged` or `Closed` from GitHub. In the same thread, send `Call link_prs with repository github.com/spikonado/sprocket and number 1071, then reply done.` The row now shows `button "2 linked PRs: 2 merged"` instead. Clicking it opens `dialog "Linked pull requests"` with links named `"<title> <state> #<number>"`, such as `"<title> Merged #1071"`, newest first. Escape closes it.

## Gotchas

- `@`, `$` and `/` in the composer open popups that capture Enter. Plain-text prompts avoid them.
- Each prompt uses real model quota on the user's dev account. Keep prompts tiny.
- `button "Copy message"` belongs to the prompt, so it proves nothing about the reply.
- A plain-text reply finishes before a click on `Stop generation` lands. The stop recipe needs a tool call to keep the run alive.
- Stopping leaves the started command running under `Running commands` until it exits on its own.
- The row's hover-only `Settle` and `Unsettle` icons never appear in this headless session, as Drive in `SKILL.md` explains. Use the right-click menu.
