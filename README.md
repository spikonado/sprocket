# Sprocket

**Goal**: To make the world's best platform for developing hardware and software.

Here's what makes Sprocket special:

- The only AI agent that can work on both <ins>hardware</ins> and <ins>software</ins>.
- Retrieves best-in-class <ins>context from the web</ins> for everything it does, so it stays <ins>incredibly reliable</ins>.
- <ins>Buys anything from any website</ins> when you ask, from hardware parts to SaaS subscriptions.
- Makes <ins>beautifully detailed schematics</ins>, creates your <ins>BOM</ins>, and writes <ins>assembly instructions</ins>.

[Sprocket Demo](https://www.youtube.com/watch?v=E8KWO3Vh9YU)

[![Sprocket](./assets/sprocket.png)](https://www.youtube.com/watch?v=E8KWO3Vh9YU)

## Using Sprocket

> [!NOTE]
> You can run Sprocket using any of the ways defined below with no impact on Sprocket's capabilities or performance.
> The desktop app may take more RAM than using Sprocket through your browser.

### Run without installing

```sh
npx @spikonado/sprocket
```

The above runs Sprocket through your browser unless you have the desktop app installed.
Browser launch URLs contain workspace navigation state only. The local server
creates the browser session after checking the socket peer, Origin, and Host.

### Remote browser access

Keep Sprocket on its default loopback address and put an HTTPS reverse proxy in
front of it. For example, Tailscale Serve can expose the local server inside
your tailnet:

```sh
tailscale serve --bg http://127.0.0.1:17731
```

Open the HTTPS URL printed by Tailscale. Remote browser sign-in uses WorkOS
device authorization and accepts only the account already signed in by
`sprocket login` on the host. Signing out in that browser revokes its browser
session without signing the host out. Plain remote HTTP is rejected. Other
reverse proxies must connect to Sprocket over loopback and preserve the
browser-facing `Host` header.

### Desktop app

Install it for your OS from the latest [GitHub Release Artifacts](https://github.com/spikonado/sprocket/releases) and run it.

### CLI

```sh
npm i -g @spikonado/sprocket
sprocket
```

The above runs Sprocket through your browser unless you have the desktop app installed.

To always open a tab in your browser when using Sprocket, use the `--web` flag:

```sh
sprocket --web
```

### Run an agent from the CLI

```sh
sprocket login
sprocket run "Fix the failing tests"
sprocket run --thread <thread-id> "Add regression coverage"
```

Inline prompts, `--prompt-file`, and stdin report only the current run. `--thread`
uses its history as context without replaying it. Progress goes to stderr, the
final answer to stdout, and full transcripts remain in the data directory and app.

### Workspaces

Pass a directory to open or reconnect that workspace in a new thread:

```sh
sprocket .
sprocket --web ../my-robot
```

Sprocket remembers attached workspaces and local server sessions between launches.
Local state lives in `$HOME/.sprocket` (or `%USERPROFILE%\.sprocket` on Windows when `HOME` is unset).
Override with `SPROCKET_DATA_DIR`.

## Additional CLI reference

| Command                     | Behavior                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| `sprocket update`           | Update a global npm, bun, pnpm, or yarn install on the current channel.        |
| `sprocket update --check`   | Report whether an update is available without installing.                      |
| `sprocket upgrade`          | Alias for `update`.                                                            |
| `sprocket serve`            | Run the local server in the foreground without launching a client.             |
| `sprocket serve --api-only` | Serve only `/api`; intended for development (see [Development](#development)). |

Run `sprocket --help` or `sprocket serve --help` for all options.

Common Sprocket server overrides are available as environment variables:

| Variable                      | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `SPROCKET_DATA_DIR`           | Directory for internal process identity, sessions, and workspace state. |
| `SPROCKET_PORT`               | Local server port; defaults to `17731` for installed use.               |
| `SPROCKET_HOST`               | Bind host; defaults to `127.0.0.1`.                                     |
| `SPROCKET_DESKTOP_EXECUTABLE` | Full path to the desktop executable to be used by the Sprocket CLI.     |
| `PUBLIC_CONVEX_URL`           | Convex deployment used by the agent runtime.                            |
| `PUBLIC_MODEL_GATEWAY_URL`    | Public AI gateway origin for the UI catalog (`GET /api/v1/models`).     |
| `SPROCKET_STATIC_DIR`         | Web build to serve instead of the bundled build.                        |

## Development

### Requirements

- Bun 1.x, version 1.4.2 or newer
- Node.js 24.x, version 24.14 or newer
- A current stable Rust toolchain

Install dependencies:

```sh
bun install
```

### Running Sprocket

Start the browser development environment:

```sh
bun dev
```

This runs Vite at `http://localhost:5173` and the Rust API at `http://127.0.0.1:7731`, with development state kept in `.sprocket-dev` inside the repository.
It targets the dev Convex deployment. To run against the production Convex
deployment with `~/.sprocket` state instead:

```sh
bun dev:prod
```

To develop against Electron instead, run:

```sh
bun dev:desktop
```

The `dev:prod` / `dev:prod:desktop` variants use the production Convex deployment and `~/.sprocket`.

After creating a Convex deployment and configuring AuthKit, give the deployment an API key for each model provider you want to enable.

### Dodo Payments

Self-serve checkout on `spikonado.com/pricing` uses the Sprocket Convex deployment. Configure these variables in each Convex deployment:

- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_ENVIRONMENT`, set to `test_mode` or `live_mode`
- `DODO_PAYMENTS_WEBHOOK_SECRET`
- `DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS`, optional provider-confirmed positive integer retention window; absent/expired proof disables ambiguous create retries, not status lookup
- `SPROCKET_MARKETING_ORIGIN`, set to `https://spikonado.com` in production
- `SPROCKET_BILLING_STAGING_ORIGIN`, optional single operator-approved HTTPS origin for test mode; no wildcard, credentials, path, or query

Missing/invalid billing configuration must fail closed for checkout without disrupting non-billing features. Never put provider credentials in client `PUBLIC_*` variables. The website's `PUBLIC_CONVEX_URL` and explicit `PUBLIC_DODO_CHECKOUT_MODE` must target the matching deployment/mode. Invalid return origins are errors, not silent production redirects. See `apps/web/.env.example`. Merchant settings, launch tests, and operational recovery are maintained in the Sprocket project artifact **Dodo dashboard setup for Sprocket** (`ks74f9xxtjp9hmgj0ackvxk9698f0f2g`). Configured credentials and products make checkout available; there is no separate enable flag.

Every row in the Convex `tiers` table appears on the pricing page. Set `monthlyProductId` and `annualProductId` on a row to the matching recurring Dodo products. Either product can be omitted to make that billing interval unavailable. Product IDs must be unique across all tier and interval fields. The optional `description`, `features`, `displayOrder`, and `highlighted` fields control the pricing card.

Disable **Allow Multiple Subscriptions** in Dodo's subscription settings before enabling checkout. Every checkout uses the account's saved Dodo customer ID, including retries and different plan selections. Customers can change an unfinished purchase immediately; the older link remains payable until Dodo expires it, so Dodo must enforce one subscription per customer. Verify this with two open checkout links in test mode. The customer portal remains available after payment failure or cancellation, even when paid access has ended.

Live checkout requires **no active operator-paid grants**: verify the `subscriptions` table has no row with `status: 'active'`, `tier !== 'free'`, and no `dodoSubscriptionId`. Resolve any such grant with its owner; never delete or overwrite it automatically. The projection continues to preserve these grants against provider events, so a purchase by that account would not activate. Do not issue new non-Free grants after launch. Normal active Free bootstrap rows are allowed.

For complimentary paid-tier access, create a **100% Dodo subscription discount**, restrict it to the intended products and specific saved customers, and leave **Subscription Cycle Limit** empty for indefinite access (or set the promised number of cycles). Recipients redeem it in Sprocket's signed-in checkout with their account's saved Dodo customer, not a dashboard-created one or a generic payment link. Dodo's **Card-Optional at $0 Price** product setting can remove the card requirement. This is a Dodo-linked subscription, not a local operator grant; signed subscription events still establish access. Verify zero-charge activation, renewal, and discount-end behavior in test mode before issuing complimentary subscriptions. See the dashboard artifact for the procedure and sources.

Weekly usage resets Monday at 00:00 UTC. Free monthly usage resets on the first of the month. Monthly paid usage follows confirmed Dodo billing dates. Annual paid windows derive from the original UTC term anchor with month-end clamping and are capped at the actual confirmed term end. Normally renewing subscriptions receive at most one hour of renewal-processing access after that end, retaining the previous monthly bucket and remaining allowance until renewal is confirmed. Exhausted allowance remains exhausted. Confirmed failure/hold/expiry/effective cancellation ends access immediately; scheduled cancellation receives no processing grace afterward. This is not payment-recovery grace. Confirmed `past_due` is treated as `on_hold`, not as an access extension. Customers can repair failed payments through the portal; only a confirmed active subscription restores paid access.

Every confirmed effective tier change resets usage once, including equal-allowance changes and downgrades applied at renewal. Scheduled changes, duplicate/replayed events, status recovery, and remapping an unchanged product do not reset usage. A genuinely new subscription starts a new generation. Operator grants without a Dodo subscription ID remain unchanged. Compatibility migrations and their removal gates are recorded in `BACKWARDS_COMPATIBILITY.md`.

Point the Dodo webhook at `https://<deployment>.convex.site/dodopayments-webhook`. The signed webhook and fenced provider reconciliation, never browser return parameters, establish entitlement. Subscribe to `subscription.active`, `renewed`, `plan_changed`, `updated`, `on_hold`, `cancelled`, `expired`, and `failed`. Do not add pause/unpause or refund/dispute subscriptions. Unexpected verified types are durable unsupported outcomes, not feature support. AuthKit must allow the approved website origin for CORS and its `/pricing/callback` redirect URI.

Billing complaints and refund requests go to [aarav@spikonado.com](mailto:aarav@spikonado.com). Operators handle refunds and disputes in Dodo/email; Sprocket has no refund-request form or dedicated refund/dispute subsystem. A refund alone does not cancel future billing or change usage allowances.

### Building and testing

```sh
cargo test
bun run test
bun run build
prek run -a
```

Create a local Electron installer package with:

```sh
bun run build:release
```

Artifacts are written to `apps/desktop/dist/` as `sprocket-desktop-*` (`.AppImage` / `.dmg` / `.exe` depending on the host OS).
Published installers come from GitHub Releases; the `sprocket` CLI is published separately on npm.

## License

Sprocket is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md). Third-party material remains under the licenses listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Troubleshooting

- If `17731` is already occupied, set `SPROCKET_PORT` before launching.
- If installed sign-in cannot save or restore its native session, check that
  your operating system credential service is available. Linux development
  environments need a working Secret Service provider.
- If `sprocket` opens the browser instead of the desktop app, install `sprocket-desktop` from [GitHub Releases](https://github.com/spikonado/sprocket/releases) onto `PATH`, or set `SPROCKET_DESKTOP_EXECUTABLE`.
- Unsigned macOS and Windows desktop builds may need a Gatekeeper / SmartScreen override the first time you open them.
- Contact [aarav@spikonado.com](mailto:aarav@spikonado.com) for help.
