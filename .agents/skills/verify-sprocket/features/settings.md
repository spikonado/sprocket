# Settings

Settings replaces the inbox sidebar with a page list and shows one page in the main area. Account preferences live in Convex, and the GitHub switches live in the server profile. Settings has no URL, so a reload returns to the inbox.

## Sub-features

- `settings-open` opens settings and leaves with Back.
- `settings-nav` moves between General, Account, Providers, BYOK/BYOS, Version Control and Payments.
- `settings-pref` flips a preference switch that persists across a reload.
- `settings-github` flips `Use GitHub` for this machine.

## How to get to it (user POV)

- Choose `button "Settings"` at the bottom of the inbox sidebar. It opens General.

## Driving it with agent-browser

Precondition: the new-thread screen with the inbox sidebar visible.

- **Open.** Click `button "Settings"`. `snapshot -i` shows `button "Back"`, `navigation "Settings"` with `button "General"`, `button "Account"`, `button "Providers"`, `button "BYOK/BYOS"`, `button "Version Control"` and `button "Payments"`, then `heading "General"` and three switches: `Automatically name threads`, `Continue agents automatically after restarts` and `Settle threads when their PRs merge`.
- **Navigate.** Click each page button. The `heading` matches its name.
- **Preference.** Click `switch "Continue agents automatically after restarts"`. Its `checked` flips. Run `agent-browser reload`, wait for `New thread`, reopen Settings, and the switch keeps the new state. Click it again to restore it.
- **GitHub.** On Version Control, click `switch "Use GitHub"`. It reads `[checked=false]`, plain `snapshot` shows "GitHub is off. Agents can’t link pull requests and their status won’t refresh.", and `~/.sprocket-dev-verify/github-settings.json` has `"disabled": true`. Click it again, and the file has `"disabled": false`.
- **Back.** Click `button "Back"`. `button "New thread"` and `button "Open side panel"` return.

## Gotchas

- Preferences belong to the user's dev account. Flip one at a time and restore it. `Settle threads when their PRs merge` can settle the user's real dev threads while on.
- `Sign Out` on Account signs the shared browser out, and signing back in needs a new device code.
- BYOK/BYOS needs a real ChatGPT login or OpenAI key, Version Control tokens are checked against GitHub, and Payments needs a Prava passkey approval. Report those flows as unreachable.
- `snapshot -i` doesn't mark the current page button. Use the heading.
