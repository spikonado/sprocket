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

| Component         | Owns                                                             | Does not own                           |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Svelte app        | User interaction, reactive views, submission recovery            | Filesystem access or provider secrets  |
| Electron shell    | Desktop lifecycle, trusted renderer bridge, local server process | Conversation or agent state            |
| CLI               | Process launch and server-mode selection                         | Agent implementation                   |
| Local server      | Local authorization, workspace attachment, agent task lifetime   | Durable conversation state             |
| Agent runtime     | Run claim, model/tool loop, cancellation, finalization           | HTTP presentation or cloud schema      |
| Workspace crate   | Paths, commands, patches, workspace instructions                 | Authentication or networking           |
| Convex RPC client | Generic Convex query/mutation/action/subscribe                   | Completion translation                 |
| AI gateway        | Provider routing, OpenAI API, catalog, usage rates               | Subscription limits or remaining quota |
| Convex backend    | User data, run coordination, transcript, remaining quota         | Local paths, process execution, rates  |

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

| State                                                                | Owner                |
| -------------------------------------------------------------------- | -------------------- |
| Users, threads, messages, runs, and tool-job records                 | Convex               |
| Local folder list (`workspacePath` + `repositoryKey`)                | Local server         |
| Pairing credential and local browser sessions                        | Local server         |
| Active commands, cancellation tokens, and run execution capabilities | Local process memory |
| Source files and build artifacts                                     | User workspace       |
| Model and authentication provider secrets                            | Cloud deployment     |

The local server owns this machine’s folder list. Convex threads store a
`repositoryKey`; the web app groups those threads onto local folders whose key
matches. Folders that are not attached here stay hidden until they are added.

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
    UI->>C: Create or recover thread
    UI->>S: Start run with user token and workspace identity
    S->>A: Prepare local run
    A->>C: Create gateway run and bind execution capability
    A->>C: Claim run, load context, mint user gateway token
    A->>G: GET /api/v1/models
    loop Model and tool turns
        A->>G: POST /api/v1/responses
        G->>C: Check remaining quota
        G->>M: Call selected model
        M-->>G: Stream response
        G-->>A: OpenAI SSE
        A->>C: Persist stream events
        C-->>UI: Publish durable transcript updates
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
ambiguous network failure. Once started, a worker must hold a renewable claim;
stale workers cannot continue tool execution or overwrite a newer result.

Tool operations are recorded before and after local execution. This gives the
UI a durable audit trail and lets terminal run state cancel work still running
on the machine.

The agent persists model output incrementally to Convex. Stream attempt and
ordering metadata prevent a delayed completion attempt from replacing a newer
one.

## Authentication and trust boundaries

Cloud and local authorization solve different problems:

- **Cloud identity:** WorkOS tokens authenticate the user to Convex. Convex
  checks ownership before reading or changing user records.
- **Local authorization:** a machine-local pairing credential bootstraps a
  local session used for filesystem and agent endpoints.
- **Agent delegation:** the browser provides a fresh user token only to create
  the run. Convex then binds a random, run-scoped capability to that run, and
  the local executor uses it without depending on the browser session.
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
