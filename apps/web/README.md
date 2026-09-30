# `apps/web`

This is Sprocket's React web app. Vite builds static assets into `dist` for Rust
to serve in a browser or Electron. Both clients use the same build and load
runtime configuration from `/api/config`.

Vite writes hashed chunks and assets under `_app/immutable` to preserve Rust's
immutable-cache and missing-asset responses. Browsers revalidate `index.html`
on every request.

## Source layout

React code and its tests live in `src/`. Convex functions, their tests, and
generated API files live in `convex/`, the default layout from the
[Convex React quickstart](https://docs.convex.dev/quickstart/react). Function
names are relative to `convex/`, so the directory move did not rename any
functions.

Frontend imports use `$lib` for `src/lib` and `@convex` for `convex`. Both are
mapped in `vite.config.ts` and the `tsconfig.json` paths.

## Development checks

Run these commands from `apps/web`:

- `bun run check` checks TypeScript, including JSX and component tests.
- `bun run test` runs the frontend, React component, and Convex tests.
- `bun run build` produces the static client.

The client handles `/` and `/callback`. Rust supplies the SPA fallback for
installed clients, and Vite supplies it during development.

## Authentication

The hosted web app uses one AuthKit JS session for direct Convex access.
Installed browser and Electron clients use Rust's native WorkOS session. Rust
owns PKCE, state, code exchange, access-token refresh, and the persisted refresh
token. The renderer requests short-lived access tokens from the local API for
direct Convex calls. It never receives the native authorization code or refresh
token. Remote HTTPS browsers authenticate their browser session as the host
owner without replacing the host's native session.

`ConvexProviderWithAuth` connects this session to React. The token fetcher remains
stable across routine token refreshes and changes when the account changes or
authentication recovery requests a retry. Machine registration returns the native
user's canonical ID, and agent launch rejects a different browser user ID.

### Local setup

Use `http://localhost:5173` during development. Requests made to the IPv4 or IPv6
loopback address are redirected to `localhost` so AuthKit PKCE state, WorkOS
redirects, and Sprocket's pairing cookie remain on one browser origin.

Configure these WorkOS redirect URIs:

- `http://localhost:5173/callback` for web development
- `http://127.0.0.1:*/api/auth/desktop-login/callback` for installed browser and desktop login

The wildcard entry supports the native loopback flow when the installed port is
overridden or changes. WorkOS does not allow a wildcard redirect URI to be the
application's default redirect. Both flows reuse the same public WorkOS client
ID. Rust reads it from the public Convex query
`authBootstrap:getClientConfig`; no WorkOS client secret belongs in an
installed build.

| Mode                          | Local port |
| ----------------------------- | ---------: |
| Vite web development          |     `5173` |
| Rust API development          |     `7731` |
| Installed web and desktop app |    `17731` |

The source of truth for the JavaScript-side values is
`apps/desktop/local-config.mjs`; the installed port must also match the Rust
server's `DEFAULT_PORT`.
