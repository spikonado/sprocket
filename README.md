# Sprocket

**Goal**: To make the world's best platform for developing hardware and software, and thus, make the world's best platform for robotics development.

Sprocket is currently a coding agent that can operate in your local workspace, surf the web better than any other agent out there, and write high-quality code.

![Sprocket](./assets/sprocket.png)

## Using Sprocket

To directly launch Sprocket in the browser without having to install anything:

```sh
npx @spikonado/sprocket --web
```

Installing the `sprocket` CLI and using it:

```sh
npm i -g @spikonado/sprocket
sprocket --web
```

After installing the Sprocket desktop application and the `sprocket` CLI, launch it from a terminal:

```sh
sprocket
```

This starts the local Sprocket server and opens the separately installed desktop application.

To use Sprocket entirely in your default browser, run:

```sh
sprocket --web
```

Pass a directory to either command to add or reconnect that workspace and open a new thread for it:

```sh
sprocket .
sprocket --web ../my-robot
```

Sprocket remembers attached workspaces and local server sessions between launches.
Its local state is stored in `$HOME/.sprocket`, falling back to `%USERPROFILE%\.sprocket` on Windows when `HOME` is unavailable.
Override this with `SPROCKET_DATA_DIR`.

## CLI reference

| Command                      | Behavior                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `sprocket [DIRECTORY]`       | Start the server and desktop app, optionally opening a workspace.              |
| `sprocket --web [DIRECTORY]` | Start the server and browser app, optionally opening a workspace.              |
| `sprocket serve`             | Run the local server in the foreground without launching a client.             |
| `sprocket serve --api-only`  | Serve only `/api`; intended for development (see [Development](#development)). |

Run `sprocket --help` or `sprocket serve --help` for all options.
Common server overrides are also available as environment variables:

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

Install dependencies:

```sh
bun install
```

### Running Sprocket

Start the browser development environment:

```sh
bun dev
```

After creating a convex deployment and configuring authkit following the instructions, configure the Convex deployment with the API key for each enabled model provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `XAI_API_KEY`).

Optional Amazon Bedrock fallback for OpenAI and Anthropic: set `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`. `AWS_REGION` defaults to `us-east-1` (use a US Bedrock region; Anthropic fallback uses `us.` inference profiles).

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

Create the optimized desktop package and standalone CLI bundle with:

```sh
bun run build:release
```

Release artifacts are written to `apps/desktop/dist/`.
The Electron desktop package and standalone CLI bundle are separate artifacts.
The CLI bundle contains only the native `sprocket` executable and the static web files needed by `sprocket --web`; it does not contain Electron.

## Troubleshooting

- If `17731` is already occupied, set `SPROCKET_PORT` before launching.
- If the CLI cannot locate the desktop executable, set `SPROCKET_DESKTOP_EXECUTABLE` to its full path, or use `sprocket --web` without the desktop application.
