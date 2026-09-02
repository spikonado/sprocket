# Sprocket architecture

Sprocket is an agentic platform for streamlining hardware and software
development. Its web interface and durable conversation state are
cloud-connected, while filesystem access and command execution stay on the
user's machine.

This document describes the stable system boundaries and data flows. User setup
belongs in [README.md](README.md); crate-specific implementation notes live in
the READMEs under [`crates/`](crates/).

## Design principles

- **Local execution:** a local Rust process handles source files, patches, and
  shell processes, not the cloud backend.
- **Durable coordination:** conversations and agent-run state survive browser,
  process, and network interruptions.
- **Explicit ownership:** authenticated cloud records belong to a user, and
  active agent work belongs to a renewable run claim.
- **Portable clients:** the same web application runs in a browser, during Vite
  development, and inside Electron.
- **Layered implementation:** workspace primitives do not depend on HTTP,
  Convex, or model providers.

## System overview

```mermaid
flowchart LR
    User[User] --> Web[Svelte web app]
    CLI[Sprocket CLI] --> Desktop[Electron shell]
    Desktop --> Web
    CLI --> Local[Local Rust server]
    Desktop --> Local
    Web <--> Local
    Web <--> Convex[Convex backend]
    Local <--> Convex
    Web -->|"GET /api/v1/models"| Gateway[AI gateway]
    Local -->|"POST /api/v1/responses"| Gateway
    Gateway --> Providers[Model providers]
    Gateway -->|"quota check, consume units"| Convex
    Web <--> Auth[WorkOS]
    Local --> Workspace[Local workspace and processes]
```

The system has three main planes:

1. **Client plane:** Svelte provides the UI; Electron supplies a desktop shell;
   the CLI launches clients and the local server.
2. **Local execution plane:** the Rust server authenticates local requests,
   resolves workspace attachments, starts agent runs, and executes tools.
3. **Cloud coordination plane:** Convex stores durable application state and
   coordinates run ownership. Completions go through the AI gateway.

WorkOS establishes cloud user identity. A separate local pairing mechanism
authorizes the browser or Electron renderer to access the machine-facing API.

## Component boundaries

| Component         | Owns                                                                                                                 | Does not own                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Svelte app        | User interaction, reactive views, submission recovery                                                                | Thread-list cache, transcript synchronization, filesystem access, or provider secrets |
| Electron shell    | Desktop lifecycle, trusted renderer bridge, local server process                                                     | Conversation or agent state                                                           |
| CLI               | Process launch and server-mode selection                                                                             | Agent implementation                                                                  |
| Local server      | Local authorization, thread summary cache, transcript replica and live stream, machine sessions, agent task lifetime | Durable conversation source of truth                                                  |
| Agent runtime     | Run claim, model/tool loop, cancellation, finalization                                                               | HTTP presentation or cloud schema                                                     |
| Workspace crate   | Paths, commands, patches, workspace instructions                                                                     | Authentication or networking                                                          |
| Convex RPC client | Generic Convex query/mutation/action/subscribe                                                                       | Completion translation                                                                |
| AI gateway        | Provider routing, OpenAI API, catalog, usage rates                                                                   | Subscription limits or remaining quota                                                |
| Convex backend    | User data, run coordination, transcript, remaining quota                                                             | Local paths, process execution, rates                                                 |

The Rust dependency direction follows these boundaries:

```text
sprocket-cli -> sprocket-server -> sprocket-agent -> sprocket-convex
       |              |                |
       +--------------+----------------+-> sprocket-workspace
```

Lower layers remain usable without importing higher-level concerns.

## Runtime modes

### Desktop

The CLI launches Electron. Electron attaches to a compatible local server or
starts the packaged Rust executable, then loads the same web build used by the
browser mode. A narrow preload bridge exposes desktop-only actions to the
renderer.

### Browser

The CLI starts or reuses a local server and opens the locally served web app.
The server hosts both the static application and its machine-facing API.

### Development

Vite serves the web app while the Rust process serves only the local API.
Vite proxies API requests during development so the application code uses the
same paths in every runtime mode.

## State ownership

Sprocket deliberately separates cloud and machine-local state.

| State                                                                        | Owner                |
| ---------------------------------------------------------------------------- | -------------------- |
| Users, threads, durable transcript parts, runs, and tool-job records         | Convex               |
| Thread snapshot revisions and paged project-thread listings                  | Convex               |
| Local thread summary cache (active per attached project, archived on demand) | Local server         |
| Local transcript replica                                                     | Local server         |
| Current assistant stream                                                     | Local process memory |
| Local folder list (`workspacePath` + `repositoryKey`)                        | Local server         |
| Installation identity and this process’s machine-session credential          | Local server         |
| Machine sessions and presence                                                | Convex               |
| Pairing credential and local browser sessions                                | Local server         |
| Active commands, cancellation tokens, and run execution capabilities         | Local process memory |
| Source files and build artifacts                                             | User workspace       |
| Model and authentication provider secrets                                    | Cloud deployment     |

The local server owns this machine’s folder list and the account-isolated
thread summary cache. Convex threads store a `repositoryKey`. When a folder is
attached here, Rust watches that key’s active snapshot and writes it locally;
archived threads download when the UI asks. The web app reads the cache, not
`threads.listMine`. Folders that are not attached here stay hidden until they
are added.

Rename, archive, restore, rekey, and cancellation go through the local server
so it can refresh the affected cache files before the UI reads them again.
Thread creation and selected-thread lifecycle still talk to Convex directly.

## Agent run flow

```mermaid
sequenceDiagram
    participant UI as Web app
    participant C as Convex
    participant G as AI gateway
    participant S as Local server
    participant A as Rust agent
    participant M as Model provider
    participant W as Workspace

    UI->>G: GET /api/v1/models
    UI->>C: Create thread
    UI->>S: Start run with user token and workspace identity
    S->>C: Register account machine session
    S->>A: Prepare local run
    A->>C: Create gateway run, bind execution capability and machine session
    C-->>A: Return authoritative numbered prompt part
    A-->>S: Add prompt to local transcript replica
    S-->>UI: Notify transcript update and refetch local page
    A->>C: Claim run, load context, mint user gateway token
    A->>G: GET /api/v1/models
    loop Model and tool turns
        A->>G: POST /api/v1/responses
        G->>C: Check remaining quota
        G->>M: Call selected model
        M-->>G: Stream response
        G-->>A: OpenAI SSE
        A-->>S: Publish live completion snapshot
        S-->>UI: Stream live completion over SSE
        A->>C: Persist stream events
        C-->>S: Publish durable transcript state
        S->>C: Fetch missing numbered parts
        S-->>UI: Notify transcript update and refetch local page
        opt Model requests a tool
            A->>C: Record tool job
            A->>W: Execute locally
            A->>C: Record result
        end
    end
    G->>C: Consume quota units
    A->>C: Finalize run
```

The submission identifier makes thread and run creation safe to retry after an
ambiguous network failure. Continue-working always inserts a linked new run.
Once started, a worker must hold a renewable claim; stale workers cannot
continue tool execution or overwrite a newer result.

Tool operations are recorded before and after local execution. This gives the
UI a durable audit trail and lets terminal run state cancel work still running
on the machine.

The agent persists model output incrementally to Convex. Stream attempt and
ordering metadata prevent a delayed completion attempt from replacing a newer
one.

The transcript renderer never reads transcript content from Convex. It pages
durable parts from the Rust replica and overlays the current Rust
live-completion stream. Convex assigns durable part numbers; Svelte renders
that order and keeps no cross-thread transcript cache.

## Authentication and trust boundaries

Cloud and local authorization solve different problems:

- **Cloud identity:** WorkOS access tokens authenticate the user to Convex.
  Convex validates them as JWTs (`apps/web/src/convex/auth.config.ts`) and
  checks ownership before reading or changing user records. The browser and
  every Rust Convex client that acts as the user present this token.
- **Local authorization:** a machine-local pairing credential bootstraps a
  local session used for filesystem, cache, and agent endpoints.
- **Agent delegation:** the local server mints a random run-scoped execution
  secret when it starts a run. Convex stores only the hash. Executor
  queries and mutations authorize with that secret (`getExecutionRun`), not
  `getUserId`. Creating the run still requires the user JWT, and the Rust
  Convex client still attaches that JWT on the connection.
- **Machine session:** each local process holds a per-launch credential.
  Registration is a user-JWT mutation; heartbeat and end authorize with the
  credential hash, not the user identity.
- **Desktop trust:** Electron isolates the renderer, validates its origin, and
  exposes only a small set of IPC calls to the renderer.

The local server binds to loopback by default. Exposing it on another interface
changes the trust model and should be treated as a security-sensitive
deployment choice.

Workspace patches and shell commands are not sandboxed: both run with the
permissions of the local Sprocket process, confined only by the OS user.

## Reliability model

The distributed run protocol assumes that requests can time out after either
succeeding or failing. Its main safeguards are:

- idempotent creation keyed by a client submission identifier;
- request-independent local launch and run-scoped executor capabilities;
- renewable claims that reject stale workers;
- durable transcript and tool-job updates;
- explicit terminal states and failure reconciliation;
- cancellation propagated from durable state to local operations;
- bounded command output and process-tree termination; and
- transactional workspace patches with rollback.

These behaviors are cross-layer contracts. Changes to run ownership,
cancellation, tool payloads, history representation, or streaming must be made
in the Rust agent and Convex backend together.

## Repository layout

| Path                         | Responsibility                        |
| ---------------------------- | ------------------------------------- |
| `apps/web/`                  | Svelte application and Convex backend |
| `apps/desktop/`              | Electron shell and packaging          |
| `crates/sprocket-cli/`       | User-facing launcher                  |
| `crates/sprocket-server/`    | Local HTTP and process boundary       |
| `crates/sprocket-agent/`     | Agent run lifecycle and tools         |
| `crates/sprocket-convex/`    | Neutral Convex RPC/auth client        |
| `crates/sprocket-workspace/` | Local workspace primitives            |
| `packages/`                  | Shared JavaScript configuration       |

The AI gateway (`spikonado/ai-gateway`) is a separate private repository. Its
public origin is `https://ai-gateway.spikonado.com`, with OpenAI-compatible
routes under `/api/`.

## Build and deployment

`apps/web` builds to static assets. Those assets are packaged in two separate products:

- **`sprocket-desktop`** (GitHub Releases): Electron app that embeds the static web UI and a native `sprocket` server binary. Users get `.AppImage`/`.dmg`/`.exe` installers.
- **`sprocket` CLI** (npm `@spikonado/sprocket`): the same native binary plus the static web UI for `sprocket --web`. No Electron.

The local executable receives only public runtime configuration. WorkOS secrets
remain in the Convex deployment. Model-provider secrets live in the gateway
deployment; Convex still keeps `OPENAI_API_KEY` for browser automation.
