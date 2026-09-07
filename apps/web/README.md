# `apps/web`

This is Sprocket's web app. The same Svelte sources ship two ways:

- Bundled static files for Electron and the CLI (`bun run build`). No WorkOS secrets.
- A Vercel-hosted app at `https://sprocket.spikonado.com` (`bun run build:hosted`).

## Authentication

### Hosted web (`PUBLIC_SPROCKET_HOSTED=true`)

The Vercel origin owns a WorkOS AuthKit session in `__Host-` HttpOnly Secure cookies. Refresh tokens stay in the sealed session cookie. The browser asks `POST /api/auth/session/token` for a short-lived access token and hands that JWT to Convex.

Sign-in goes to `/api/auth/sign-in`. The callback is `/api/auth/callback`. Sign-out is `POST /api/auth/sign-out`. Token and sign-out POSTs require an `Origin` header that matches the request origin exactly. Malformed JSON on the token route is `400` and does not refresh.

`isHostedWeb` from `$lib/runtime-mode` is the build-time switch other code should use.

### Installed browser and Electron

Rust owns a native WorkOS session for agent runs and machine registration. It owns PKCE, state, code exchange, access-token refresh, and the persisted refresh token.

AuthKit JS still owns the legacy renderer session used for some older installed clients. Current installed sign-in completes the Rust loopback flow first. The renderer polls the local API for native login status and never receives the native authorization code or refresh token.

The two installed sessions must use the same WorkOS account. Machine registration returns the native user's canonical ID, and agent launch rejects it when it differs from the browser user ID.

### Local setup (bundled / Vite)

Use `http://localhost:5173` during development. Requests made to the IPv4 or IPv6 loopback address are redirected to `localhost` so AuthKit PKCE state, WorkOS redirects, and Sprocket's pairing cookie remain on one browser origin.

Do not set `PUBLIC_SPROCKET_HOSTED` in the env files used for `bun run build` or `bun run dev`. That flag selects the Vercel adapter and hosted auth routes.

Configure these WorkOS redirect URIs for installed and Vite development:

- `http://localhost:5173/callback` for web development
- `http://127.0.0.1:*/api/auth/desktop-login/callback` for installed browser and desktop login

The wildcard entry supports the native loopback flow when the installed port is overridden or changes. WorkOS does not allow a wildcard redirect URI to be the application's default redirect. Both installed flows reuse the same public WorkOS client ID. Rust reads it from the public Convex query `authBootstrap:getClientConfig`. No WorkOS client secret belongs in an installed build.

| Mode                          | Local port |
| ----------------------------- | ---------: |
| Vite web development          |     `5173` |
| Rust API development          |     `7731` |
| Installed web and desktop app |    `17731` |

The source of truth for the JavaScript-side values is `apps/desktop/local-config.mjs`. The installed port must also match the Rust server's `DEFAULT_PORT`.

## Hosted Vercel deployment

Create the Vercel project yourself. This repo does not deploy.

Set the Vercel project **Root Directory** to `apps/web`. `vercel.json` installs from the repo root and runs `bun run build:hosted`.

### Environment variables

Set these on the Vercel project. Leave them out of bundled desktop/CLI builds.

| Variable                   | Where it is used                                                  |
| -------------------------- | ----------------------------------------------------------------- |
| `PUBLIC_SPROCKET_HOSTED`   | Must be `true` for the hosted adapter                             |
| `PUBLIC_CONVEX_URL`        | Served by hosted `GET /api/config`                                |
| `PUBLIC_MODEL_GATEWAY_URL` | `https://ai-gateway.spikonado.com`; required for the model picker |
| `PUBLIC_CONVEX_SITE_URL`   | Optional public Convex site URL                                   |
| `WORKOS_CLIENT_ID`         | Same AuthKit client as Convex                                     |
| `WORKOS_API_KEY`           | Server-only. Starts with `sk_`                                    |
| `WORKOS_COOKIE_PASSWORD`   | At least 32 characters                                            |
| `WORKOS_REDIRECT_URI`      | `https://sprocket.spikonado.com/api/auth/callback`                |

Generate the cookie password with `openssl rand -base64 32`. Do not set `apiHostname` or any other custom WorkOS API domain.

`build:hosted` also sets `PUBLIC_SPROCKET_HOSTED=true` for the adapter choice. Keep the same value in Vercel env so client code and the adapter agree if someone runs `bun run build` on Vercel by mistake.

### WorkOS dashboard

Add these entries on the AuthKit Redirects page. Do not remove the local and installed redirect URIs.

- Redirect URI: `https://sprocket.spikonado.com/api/auth/callback`
- Sign-in endpoint (`initiate_login_uri`): `https://sprocket.spikonado.com/api/auth/sign-in`

If a Vercel preview origin needs login, add that origin's `/api/auth/callback` as another redirect URI. A production-only `WORKOS_REDIRECT_URI` will not complete OAuth on previews.

### Custom domain

Point `sprocket.spikonado.com` at the Vercel project. `__Host-` cookies require HTTPS, so HTTP localhost hosted-dev will not persist the session or PKCE cookies.

### Rollout order and smoke test

1. Deploy the Convex changes using the existing backend release process before opening the hosted site. The new machine protocol fields are optional, so older installed clients keep working.
2. Install a build containing the hosted machine worker on each machine you want to use. Start Sprocket there and sign in locally. Keep it running. Older builds appear as needing an update and cannot accept hosted commands.
3. Configure WorkOS and the Vercel environment above, connect the repository, and add the custom domain through Vercel's domain settings. Use the DNS record Vercel gives you.
4. Check that the model gateway allows browser requests from `https://sprocket.spikonado.com` to `/api/v1/models`. Its CORS configuration lives outside this web app.
5. Sign in on the website with the same account as the machine. Browse an existing thread with no machine selected, then select an online machine, attach a folder, and start a new thread. Check live output and cancellation. An existing thread can run only in a folder whose repository identity matches that thread.
6. Stop the selected machine. History should remain readable and the composer should stop accepting runs once presence expires. Website sign-out must not sign out the installed machine.

The machine makes outbound connections to Convex. No public machine port, Cloudflare Tunnel, or Tailscale connection is needed. Selecting a machine permits Sprocket commands to browse folders, attach workspaces, and run the agent under that machine's local user account.
