# `apps/web`

This is Sprocket's web app. It is bundled into Electron and can also run in a browser.

## Authentication

The hosted web app uses one AuthKit JS session for direct Convex access.
Installed browser and Electron clients use two independent WorkOS sessions:

- Rust owns a native session for agent runs and machine registration. It owns
  PKCE, state, code exchange, access-token refresh, and the persisted refresh
  token.
- AuthKit JS owns the renderer session used for direct browser-to-Convex calls.

Installed sign-in completes the Rust loopback flow first, then redirects through
AuthKit again to establish the renderer session. The renderer polls the local
API for native login status but never receives the native authorization code or
refresh token. Installed sign-out clears the native session before clearing the
AuthKit JS session.

The two sessions must use the same WorkOS account. Machine registration returns
the native user's canonical ID, and agent launch rejects it when it differs from
the browser user ID.

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
