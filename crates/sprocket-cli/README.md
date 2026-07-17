# sprocket-cli

`sprocket-cli` builds the user-facing `sprocket` executable. It selects a
runtime mode, resolves an optional workspace, launches the desktop application,
or runs the local server for browser and development use.

The crate is binary-only. Reusable server behavior belongs in
[`sprocket-server`](../sprocket-server/README.md), and path behavior belongs in
[`sprocket-workspace`](../sprocket-workspace/README.md).

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for runtime topology and packaging.

## Responsibilities

- Parse the desktop, browser, and server launch modes.
- Canonicalize a workspace before forwarding it to another process.
- Locate and launch the installed desktop application.
- Start or safely reuse a compatible local server in browser mode.
- Provide the server entry point used by Electron and development scripts.

Server reuse is verified against local pairing state so a process on the
expected port is not trusted merely because it responds like Sprocket.

All implementation currently lives in `src/main.rs`. Keep authentication,
workspace execution, and agent behavior in their library crates rather than
duplicating them here.

## Validation

```sh
cargo test -p sprocket-cli
prek run -a
```
