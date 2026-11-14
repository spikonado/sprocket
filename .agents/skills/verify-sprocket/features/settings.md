# Settings

Settings replaces the inbox sidebar with a page list and shows one page in the main area. General preference switches persist in the user's account. Account is profile, usage, and Sign Out. AI Usage charts the account's recorded model calls. The GitHub switches live in the server profile. Settings has no URL, so a reload returns to the inbox.

## Sub-features

- `settings-open` opens settings and leaves with Back.
- `settings-nav` moves between the pages in `navigation "Settings"`.
- `settings-ai-usage` switches the AI Usage range and metric.
- `settings-pref` flips a preference switch that persists across a reload.
- `settings-github` flips `Use GitHub` for this machine on Connectors.
- `settings-byok` shows the BYOK/BYOS cards and rejects a bogus API key.

## How to get to it (user POV)

- Choose `button "Settings"` at the bottom of the inbox sidebar. It opens General.

## Driving it with agent-browser

Precondition: the new-thread screen with the inbox sidebar visible.

- **Open.** Click `button "Settings"`. `snapshot -i` shows `button "Back"`, `navigation "Settings"` with one button per page, then `heading "General"` and its preference switches.
- **Navigate.** Click each page button. The `heading` matches its name.
- **Providers.** Click `button "Providers"`. `list "Provider order"` shows `uiPreferences.providerOrder` as stored, one `switch` per provider. Every row except Spikonado and Muse has `button "Remove <provider>"`, which swaps to `button "Remove"` and `button "Cancel"`. Confirming deletes that provider's credential, so only confirm on a provider without one, or one you added for the run.
- **Connectors.** Click `button "Connectors"`. The GitHub and Vercel cards show their CLI version once installed, install progress, or the install error with `button "Retry"`. GitHub lists one row per host with its sign-in state, and Vercel has an `Account` row. The KiCad card offers Install, Update or Uninstall. Leave the buttons alone unless the run is meant to change this machine's connectors.
- **BYOK/BYOS.** Click `button "BYOK/BYOS"`. Subscription cards come first, then one `region` per API-key provider reading `Connected` or `Not configured`, with `button "Connect API key"` disabled until its `textbox "API key"` has text. In the `OpenRouter` region, type `sk-or-bogus` and click `button "Connect API key"`. The region shows the alert `OpenRouter rejected this API key.` and stays `Not configured`.
- **Muse.** The `Muse Code Subscription` card shows the state of this machine's `muse` CLI, which is one of these: missing or outdated, signed out, on a plan without Muse Wonder Full, or `Connected as <account>`. Signed in, Providers also lists `Muse Code Subscription`. Install changes this machine and sign-out needs `muse logout` in a terminal, so leave both alone.
- **AI Usage.** Send a prompt first, as in [threads.md](./threads.md). On AI Usage, `30 days` and `Tokens` are selected. Click `button "24 hours"`. The chart's x-axis shows local hours ending at `Now`, the newest bar holds the prompt's tokens, and the `Tokens` stat equals `Uncached input` plus `Cache write` plus `Output` under `TOKEN TYPES`. Hovering a bar shows a tooltip with each model in that hour; `Total` appears only when the bar has more than one model. Click `button "API cost"`; `TOKEN TYPES` becomes `API COST BY TOKEN TYPE` with dollar amounts, and the `API cost` stat equals their sum without `Reasoning`, which `Output` already prices. The stat and amounts read `—` when the catalog can't price the recorded calls: missing `directApiPricing`, or cache writes without a price for their duration. In the `MODELS` table, click a model's button. Its `aria-pressed` flips, the row dims, and the stats and chart leave it out.
- **Preference.** Click `switch "Continue agents automatically after restarts and crashes"`. Its `checked` flips. Run `agent-browser reload`, wait for `New thread`, reopen Settings, and the switch keeps the new state. Click it again to restore it.
- **GitHub.** On Connectors, wait until `switch "Use GitHub"` is present and not `[disabled]`. It starts as `Checking GitHub…` with the switch disabled. After a click it is disabled again until the save finishes; the JSON file updates first, then `checked`. Click it. It reads `[checked=false]`, plain `snapshot` shows "GitHub is off. Agents can’t link pull requests and their status won’t refresh.", and `~/.sprocket-dev-verify/github-settings.json` has `"disabled": true`. Click it again, wait until it is not disabled, and the file has `"disabled": false`.
- **Back.** Click `button "Back"`. The new-thread screen or selected thread workspace returns, along with `button "New thread"`.

## Gotchas

- Preferences belong to the user's dev account. Flip one at a time and restore it. `Settle threads when their PRs merge` can settle the user's real dev threads while on.
- `Sign Out` on Account signs the shared browser out, and signing back in needs a new device code.
- Connecting a BYOK/BYOS provider needs a real ChatGPT, Claude or Muse login or a real API key, signing in to GitHub or Vercel needs the user to approve a device code, and saving a card on Payments needs an Agentcard passkey. Report those flows as unreachable. Connectors Install/Uninstall changes packages on this machine; report that mutation as skipped unless the run is meant to change them.
- `snapshot -i` doesn't mark the current page button. Use the heading.
