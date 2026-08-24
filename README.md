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
| `sprocket serve`            | Run the local server in the foreground without launching a client.             |
| `sprocket serve --api-only` | Serve only `/api`; intended for development (see [Development](#development)). |

Run `sprocket --help` or `sprocket serve --help` for all options.

Common Sprocket server overrides are available as environment variables:

| Variable                      | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `SPROCKET_DATA_DIR`           | Directory for pairing, sessions, and workspace state.               |
| `SPROCKET_PORT`               | Local server port; defaults to `17731` for installed use.           |
| `SPROCKET_HOST`               | Bind host; defaults to `127.0.0.1`.                                 |
| `SPROCKET_DESKTOP_EXECUTABLE` | Full path to the desktop executable to be used by the Sprocket CLI. |
| `PUBLIC_CONVEX_URL`           | Convex deployment used by the agent runtime.                        |
| `SPROCKET_STATIC_DIR`         | Web build to serve instead of the bundled build.                    |

## Development

### Requirements

- Bun 1.x, version 1.3.9 or newer
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

After creating a Convex deployment and configuring AuthKit, give the deployment an API key for each model provider you want to enable.

This runs Vite at `http://localhost:5173` and the Rust API at `http://127.0.0.1:7731`, with development state kept in `.sprocket-dev` inside the repository.
To develop against Electron instead, run:

```sh
bun dev:desktop
```

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

## Troubleshooting

- If `17731` is already occupied, set `SPROCKET_PORT` before launching.
- If `sprocket` opens the browser instead of the desktop app, install `sprocket-desktop` from [GitHub Releases](https://github.com/spikonado/sprocket/releases) onto `PATH`, or set `SPROCKET_DESKTOP_EXECUTABLE`.
- Unsigned macOS and Windows desktop builds may need a Gatekeeper / SmartScreen override the first time you open them.
- Contact [aarav@spikonado.com](mailto:aarav@spikonado.com) for help.
