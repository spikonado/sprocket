# sprocket-workspace

`sprocket-workspace` contains the local workspace primitives shared by the CLI,
server, and agent runtime. It is deliberately independent of HTTP, Convex, and
model providers.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for its role in the complete system.

## Responsibilities

- Resolve and browse workspace paths.
- Load scoped workspace instructions and skills.
- Run cancellable shell commands and manage long-running sessions.
- Apply multi-file patches, including paths outside the workspace.

## Design

Path and patch operations canonicalize their inputs without confining them to
the workspace: patch paths may point anywhere the Sprocket process can write,
including through symlinks. Patches are prepared before mutation, serialized
per workspace, and rolled back when application fails.

Command execution has a different trust boundary. Commands start in the
workspace by default, but they are not sandboxed and may access the wider
machine with the permissions of the Sprocket process. Output is bounded, and
cancellation or timeout stops the process tree.

Workspace instruction loading follows the project hierarchy so deeper
instructions can refine root-level guidance without coupling that behavior to
the agent implementation.

## Main areas

- `workspace.rs`, `paths.rs`, and `browse.rs`: path resolution and selection.
- `agents.rs`: workspace instruction discovery.
- `skills.rs`, `skills/`, and `.agents/skills/`: skill discovery and built-in
  skill embedding.
- `tools.rs`: command sessions and cancellation.
- `patch.rs`: transactional patches.

## Built-in skills

Built-in skills are compiled into the binary by `build.rs` and come from two
directories:

- `skills/`: authored in this repo.
- `.agents/skills/`: vendored verbatim from the ecosystem with the
  [`skills` CLI](https://skills.sh), tracked by `skills-lock.json`. Never edit
  vendored files; `cargo test` re-hashes them against the lock. Manage them
  from the repository root:

  ```sh
  bun run skills:add <owner/repo> --skill <name>
  bun run skills:update
  ```

Each built-in is a single [Agent Skill](https://agentskills.io/specification)
`SKILL.md`: frontmatter `name` must match the directory name and `description`
must be a single-line string. Embedded skills have no on-disk directory at
runtime, so anything beyond `SKILL.md` (scripts, references, assets) would be
silently invisible to the agent — the build rejects extra files instead. A
skill name present in both directories also fails the build.

Project and user skills override built-ins by name. Discovery scans, in
order: the project's `.sprocket/skills` and `.agents/skills`, then the user's
`~/.sprocket/skills`, `~/.agents/skills`, and `~/.config/agents/skills`.

The crate exposes these capabilities through the re-exports in `src/lib.rs`.

## Validation

```sh
cargo test -p sprocket-workspace
prek run -a
```
