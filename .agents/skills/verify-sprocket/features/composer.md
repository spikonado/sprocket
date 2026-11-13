# Composer

The controls around the prompt box: the model and reasoning picker, file attachments, and the `@`, `$` and `/` popups that insert paths, skills and commands. Sending and stopping are in [threads.md](./threads.md).

## Sub-features

- `composer-model` picks a model and a reasoning effort.
- `composer-fast` turns on Fast mode for a model that offers it.
- `composer-attach` attaches files, shows upload progress, removes one, and sends them with the prompt.
- `composer-paths` searches the project with `@` and inserts a markdown link to the chosen path.
- `composer-skills` lists skills with `$` and inserts the chosen one.
- `composer-commands` lists commands with `/`, which are the skills marked `disable-model-invocation: true`.

## How to get to it (user POV)

- On the new-thread screen or an open thread, use the row under the prompt box: the paperclip, then the model name.
- Type `@`, `$` or `/` in the prompt box.

## Driving it with agent-browser

Precondition: the composer is idle, on project `verify-sprocket-scratch`.

- **Model menu.** Click `button "Select model"`. Its text and `title` read `<model> · <effort>`. `dialog "Model"` holds `group "Models"` with one button per model and `group "Reasoning for <model>"` for the current model; `agent-browser focus` another model's button to switch the group to it. Models list different efforts, and the default one ends with ` (default)`. Click an effort. The dialog closes and the trigger `title` becomes `<model> · <effort>`. Escape closes the dialog unchanged.
- **Restore model.** The choice is saved for the account. Reopen the menu, focus the original model, and click its effort to put it back.
- **Fast.** When the selected model offers it, `dialog "Model"` has `group "Speed"` with `switch "Fast"`, and the trigger gains ` · Fast`.
- **Attach.** `agent-browser upload 'input[type=file]' <file>`. `list "Attached files"` appears above the prompt with `listitem "<name> · <size>"`, `status "Uploading <name>"` until the upload finishes, and `button "Remove <name>"`.
- **Remove.** Click `button "Remove <name>"`. The list goes away.
- **Send with a file.** Attach again, type `Reply with the single word ok` and click `button "Send message"`. The prompt in `region "Conversation history"` has its own `list "Attached files"` with `button "Download <name>"` for a text file.
- **Paths.** Click the combobox and `keyboard type "@READ"`. `listbox "Workspace files and directories"` shows `option "README.md" [selected]` and one option per matching path, directories ending in `/`. Press Enter. `agent-browser get value` on the combobox reads `[README.md](README.md) `.
- **Skills.** `agent-browser press Control+a`, then type `$`. `listbox "Available skills"` has one `option "$<name> <description>"` per skill from the project's and the user's `.agents/skills` and `.sprocket/skills`. Typing filters it. Enter inserts `$<name> `, or `/<name> ` for a command skill such as `release`.
- **Commands.** Replace the text with `/`. `listbox "Available commands"` lists only command skills, as `option "/<name> <description>"`. Type `zzzz` and it becomes `status "Available commands"` reading `No matching commands`.
- **Dismiss.** Escape closes a popup and leaves the typed text in the box.

## Gotchas

- `composer-fast` is unreachable on the dev account: no model in the dev catalog lists the `fast` service tier, so no `group "Speed"` appears for any model.
- `button "Attach files"` opens a native file chooser that agent-browser can't drive, so Attach uploads into the hidden input.
