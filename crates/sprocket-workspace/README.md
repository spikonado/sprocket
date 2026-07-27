# sprocket-workspace

`sprocket-workspace` contains the local workspace primitives shared by the CLI,
server, and agent runtime. It is deliberately independent of HTTP, Convex, and
model providers.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for its role in the complete system.

## Responsibilities

- Resolve and browse workspace paths.
- Load scoped workspace instructions and skills.
- Run cancellable shell commands and manage long-running sessions.
- Apply multi-file patches inside a workspace.

## Design

Path and patch operations canonicalize their inputs and prevent patch paths
from escaping the workspace, including through symlinks. Patches are prepared
before mutation, serialized per workspace, and rolled back when application
fails.

Command execution has a different trust boundary. Commands start in the
workspace by default, but they are not sandboxed and may access the wider
machine with the permissions of the Sprocket process. Output is bounded, and
timeouts stop the process tree. Cancelling an observer (including an agent run)
detaches it without stopping the command; the session remains available for a
later observer until it is explicitly terminated or its timeout expires.

Workspace instruction loading follows the project hierarchy so deeper
instructions can refine root-level guidance without coupling that behavior to
the agent implementation.

## Main areas

- `workspace.rs`, `paths.rs`, and `browse.rs`: path resolution and selection.
- `agents.rs`: workspace instruction discovery.
- `skills.rs` and `skills/`: skill discovery and built-in skill embedding.
- `tools.rs`: command sessions and cancellation.
- `patch.rs`: confined transactional patches.

## Built-in skills

Each subdirectory of `skills/` is an [Agent Skill](https://agentskills.io/specification):

```text
skills/
  my-skill/
    SKILL.md          # required
    scripts/          # optional
    references/       # optional
    assets/           # optional
```

`SKILL.md` must use YAML frontmatter whose `name` matches the directory name.
`description` must be a single-line string (quoted or unquoted). Built-in skills
under `skills/` are compiled into the binary by `build.rs`.

The crate exposes these capabilities through the re-exports in `src/lib.rs`.

## Validation

```sh
cargo test -p sprocket-workspace
prek run -a
```
