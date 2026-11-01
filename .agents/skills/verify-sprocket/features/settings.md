# Settings

Settings replaces the inbox sidebar with a page list and shows one page in the main area. General preference switches persist in Convex (`uiPreferences`). Account is profile, usage, and Sign Out. AI Usage charts the account's recorded model calls. The GitHub switches live in the server profile. Settings has no URL, so a reload returns to the inbox.

## Sub-features

- `settings-open` opens settings and leaves with Back.
- `settings-nav` moves between General, Account, AI Usage, Providers, BYOK/BYOS, Version Control, Connectors and Payments.
- `settings-ai-usage` switches the AI Usage range and metric.
- `settings-pref` flips a preference switch that persists across a reload.
- `settings-github` flips `Use GitHub` for this machine.

## How to get to it (user POV)

- Choose `button "Settings"` at the bottom of the inbox sidebar. It opens General.

## Driving it with agent-browser

Precondition: the new-thread screen with the inbox sidebar visible.

- **Open.** Click `button "Settings"`. `snapshot -i` shows `button "Back"`, `navigation "Settings"` with `button "General"`, `button "Account"`, `button "AI Usage"`, `button "Providers"`, `button "BYOK/BYOS"`, `button "Version Control"`, `button "Connectors"` and `button "Payments"`, then `heading "General"` and four switches: `Automatically name threads`, `Continue agents automatically after restarts and crashes`, `Settle threads when their PRs merge` and `Share anonymous conversation data to help improve Sprocket for everyone`. Only the last one shows a description under its switch, with `link "our Privacy Policy"` to `https://spikonado.com/privacy` and `link "fair-source"` to `https://github.com/spikonado/sprocket`, both opening in a new tab.
- **Navigate.** Click each page button. The `heading` matches its name.
- **Connectors.** Click `button "Connectors"`. `heading "Connectors"` and a KiCad card labeled `Experimental`. Installed shows `button "Uninstall"` (and `button "Update"` when an update is available); not installed shows `button "Install"` or `Retry` after a failed install. Leave the buttons alone unless the run is meant to change this machine's connectors.
- **AI Usage.** Send a prompt first, as in [threads.md](./threads.md). On AI Usage, `30 days` and `Tokens` are selected. Click `button "24 hours"`. The chart's x-axis shows local hours ending at `Now`, the newest bar holds the prompt's tokens, and the `Tokens` stat equals `Uncached input` plus `Cache write` plus `Output` under `TOKEN TYPES`. Hovering a bar shows a tooltip with each model in that hour; `Total` appears only when the bar has more than one model. Click `button "API cost"`; `TOKEN TYPES` becomes `API COST BY TOKEN TYPE` with dollar amounts, and the `API cost` stat equals their sum without `Reasoning`, which `Output` already prices. The stat and amounts read `—` when the catalog can't price the recorded calls: missing `directApiPricing`, or cache writes without a price for their duration. In the `MODELS` table, click a model's button. Its `[pressed]` flips, the row dims, and the stats and chart leave it out.
- **Preference.** Click `switch "Continue agents automatically after restarts and crashes"`. Its `checked` flips. Run `agent-browser reload`, wait for `New thread`, reopen Settings, and the switch keeps the new state. Click it again to restore it.
- **GitHub.** On Version Control, wait until `switch "Use GitHub"` is present and not `[disabled]`. It starts as `Checking GitHub…` with the switch disabled. After a click it is disabled again until the save finishes; the JSON file updates first, then `checked`. Click it. It reads `[checked=false]`, plain `snapshot` shows "GitHub is off. Agents can’t link pull requests and their status won’t refresh.", and `~/.sprocket-dev-verify/github-settings.json` has `"disabled": true`. Click it again, wait until it is not disabled, and the file has `"disabled": false`.
- **Back.** Click `button "Back"`. `button "New thread"` and `button "Open side panel"` return.

## Gotchas

- Preferences belong to the user's dev account. Flip one at a time and restore it. `Settle threads when their PRs merge` can settle the user's real dev threads while on.
- `Sign Out` on Account signs the shared browser out, and signing back in needs a new device code.
- BYOK/BYOS needs a real ChatGPT login or OpenAI key, the server checks Version Control tokens against GitHub, and saving a card on Payments needs an Agentcard passkey. Report those flows as unreachable. Connectors Install/Uninstall changes packages on this machine; report that mutation as skipped unless the run is meant to change them.
- `snapshot -i` doesn't mark the current page button. Use the heading.
