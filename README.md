# Sprocket

Sprocket is an agentic workspace for building robots and robot applications. It
connects an AI coding agent to a local project while keeping filesystem and
command execution on your machine.

## Using Sprocket

Prebuilt releases are not published yet. To create installable artifacts from
source, follow [Development](#development) and run `bun run build:release`.

After installing the Sprocket desktop application and its `sprocket` CLI,
launch it from a terminal:

```sh
sprocket
```

This starts the local Sprocket server and opens the desktop application. To use
the same application entirely in your default browser, run:

```sh
sprocket --web
```

Keep that command running while using the browser app. In either mode, the app
is served locally at `http://127.0.0.1:17731`; it is not exposed to the network
by default.

After Sprocket opens:

1. Sign in. Desktop sign-in opens your system browser and returns to Sprocket
   when authentication completes.
2. Open or enter the path to a local workspace.
3. Describe the work you want completed in the prompt box.
4. Review the agent's progress, tool calls, and changes in the conversation.
5. Continue the conversation to refine or extend the result.

Sprocket remembers attached workspaces and local server sessions between
launches. Its local state is stored in `$HOME/.sprocket`, falling back to
`%USERPROFILE%\.sprocket` on Windows when `HOME` is unavailable. Override this
with `SPROCKET_DATA_DIR`.

## CLI reference

| Command                     | Behavior                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| `sprocket`                  | Start the server and desktop app.                                              |
| `sprocket --web`            | Start the server and open only the browser app.                                |
| `sprocket serve`            | Run the local server in the foreground without launching a client.             |
| `sprocket serve --open`     | Run the server and open its browser app.                                       |
| `sprocket serve --api-only` | Serve only `/api`; intended for development (see [Development](#development)). |

Run `sprocket --help` or `sprocket serve --help` for all options. Common server
overrides are also available as environment variables:

| Variable              | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `SPROCKET_HOST`       | Bind host; defaults to `127.0.0.1`.                       |
| `SPROCKET_PORT`       | Local server port; defaults to `17731` for installed use. |
| `SPROCKET_DATA_DIR`   | Directory for pairing, sessions, and workspace state.     |
| `SPROCKET_STATIC_DIR` | Web build to serve instead of the bundled build.          |
| `PUBLIC_CONVEX_URL`   | Convex deployment used by the agent runtime.              |

## Development

### Requirements

- Bun 1.x, version 1.3.9 or newer
- Node.js 24.x, version 24.14 or newer
- A current stable Rust toolchain
- A Convex deployment
- A WorkOS AuthKit application

Install dependencies:

```sh
bun install
```

Add `PUBLIC_CONVEX_URL` to the repository's `.env` file. Configure the Convex
deployment with `WORKOS_CLIENT_ID` and the API key for each enabled model
provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `XAI_API_KEY`).

Configure these redirect URIs in the WorkOS application:

- `http://localhost:5173/callback`
- `http://127.0.0.1:*/api/auth/desktop-login/callback`

Start the browser development environment:

```sh
bun run dev
```

This runs Vite at `http://localhost:5173` and the Rust API at
`http://127.0.0.1:7731`, with development state kept in `.sprocket-dev` inside
the repository. Development uses `7731` rather than the installed app's
`17731`. To develop against Electron instead, run:

```sh
bun run dev:desktop
```

### Building and testing

```sh
cargo test
bun run test
bun run build
prek run -a
```

The final command runs all configured formatting and linting checks.

Create the optimized desktop package and standalone CLI artifact with:

```sh
bun run build:release
```

Release artifacts are written to `apps/desktop/dist/`.

## Troubleshooting

- Use `http://localhost:5173`, not `127.0.0.1:5173`, for browser development so
  WorkOS PKCE state and local cookies remain on one origin. Sprocket corrects
  the development URL automatically when possible.
- If `17731` is already occupied, set `SPROCKET_PORT` before launching. The
  wildcard WorkOS redirect above allows the native callback to follow the new
  port.
- If the CLI cannot locate the desktop executable, set
  `SPROCKET_DESKTOP_EXECUTABLE` to its full path. `sprocket --web` can also fall
  back to the bundled browser application when available.
