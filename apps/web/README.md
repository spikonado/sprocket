# `apps/web`

This is Sprocket's web app. It is bundled into Electron and can also run in a browser.

## Local authentication

Use `http://localhost:5173` during development. Requests made to the IPv4 or IPv6
loopback address are redirected to `localhost` so AuthKit PKCE state, WorkOS
redirects, and Sprocket's pairing cookie remain on one browser origin.

Configure these WorkOS redirect URIs:

- `http://localhost:5173/callback` for web development
- `http://127.0.0.1:*/api/auth/desktop-login/callback` for installed browser and desktop login

The wildcard entry supports the native loopback flow when the installed port is
overridden or changes. WorkOS does not allow a wildcard redirect URI to be the
application's default redirect.

| Mode                          | Local port |
| ----------------------------- | ---------: |
| Vite web development          |     `5173` |
| Rust API development          |     `7731` |
| Installed web and desktop app |    `17731` |

The source of truth for the JavaScript-side values is
`apps/desktop/local-config.mjs`; the installed port must also match the Rust
server's `DEFAULT_PORT`.
