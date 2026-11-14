# Unsaved changes

Closing the window or quitting while a file has unsaved edits asks `Leave Sprocket?` with `Leave` and `Stay` in a native dialog. `Stay` keeps the window and the edits.

## Sub-features

- `unsaved-prompt` shows `Leave Sprocket?` on close with an unsaved file.
- `unsaved-stay` keeps the window and the edit.
- `unsaved-leave` closes the window and quits the app and its server.
- `unsaved-clean` closes without a prompt when nothing is unsaved.

## How to get to it (user POV)

- Edit a file in a workspace tab without saving, then close the window.

## Driving it with agent-browser and xdotool

Preconditions:

- Signed in, with `/tmp/verify-sprocket-scratch` attached.
- `README.md` open and edited without saving, as in [`verify-sprocket`'s files](../../verify-sprocket/features/files.md).

Use `$X` from the skill's Drive section.

- **Prompt.** Close the window as a user does: `$X search --name Sprocket windowquit`. Wait, then `$D/screen.sh $OUT/02-prompt.png` shows `Leave Sprocket?` and "Changes you made may not be saved."
- **Stay.** Find the dialog with `$X search --name 'Leave Sprocket'` and `$X getwindowgeometry <id>`, then click the right half of its bottom button row with `$X mousemove <x> <y> click 1`. The CDP page still answers `agent-browser get url`, and the editor keeps the edit.
- **Leave.** Close again and click the left half of the button row. `curl -s localhost:9393/json/version` fails and 7731 stops listening, then run Cleanup.
- **Clean.** Save or discard the edit first, then close. No dialog appears.

## Gotchas

- Unverified in Sprocket. `windowquit` and the `Stay` and `Leave` clicks were proven on a stand-in Electron app with the same `showMessageBoxSync` call, on Xvfb with openbox.
- `agent-browser close` only disconnects CDP. It never closes the window, so it cannot reach this prompt.
