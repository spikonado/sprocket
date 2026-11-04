---
name: improve-agent-tools
description: Audit Sprocket's agent tools one group at a time and cut their descriptions, schemas, outputs, and mechanisms down to what the model needs.
disable-model-invocation: true
---

# Improve agent tools

## Steps

1. Map what the model reads about the tools: the tools in `crates/sprocket-agent/src/tools/`, their Convex jobs in `apps/web/convex/`, `crates/sprocket-agent/src/system_prompt.md`, `crates/sprocket-agent/src/workspace_context.rs`, and the bundled skills in `crates/sprocket-workspace/skills/`. Group related tools, such as commands, files, or web, and propose an order.
2. For each group, `git fetch` and read the code from the default branch on the remote. Tools change between groups, so re-read even code you saw earlier. Then show the user:
   - Each description and full input JSON schema, verbatim, as the model receives them after any patches the code applies.
   - The output. With no declared output schema, derive one from the serialized types or the backend that builds the result, and mark the fields that only sometimes appear.
   - Numbered recommendations from [What to cut](#what-to-cut). Give each one its evidence and your view, including the ones you'd skip.

   The step is done when the user has picked by number.

3. Split the picks into PRs by the code they touch. Give each PR to a subagent with a short prompt: the picks, where the code lives, and to create a worktree, `set_cwd` into it, and open one PR. Continue with the next group while they work, and check on them only when the user asks or a PR needs you.
4. When the user redirects a design mid-flight, stop that subagent and send it the new design for the same worktree and PR.
5. When a PR is ready, check its final schemas against the picks, since subagents put back text the user cut. Show the schemas to the user before you call the group done.
6. Keep one table of every group, its PRs, and their state, and show it when asked.

Use `$writing-for-agents` for all text the model reads.

## What to cut

Each fact lives in one place. The system prompt says what a thing is, a skill owns a workflow, and a tool description says what the call does.

### Descriptions and args

- Restated facts: text the name or schema already carries, or a sentence also in the system prompt, a skill, or the run context. One case was "Relative paths resolve from the current working directory" on every path arg, which the run context already said.
- Hidden behavior that the model learns only by failing: formats listed only in an error, rate limits, all-or-nothing writes, or a question answer that starts a new turn. State it in one short clause.
- False claims, such as "ANY type of file".
- Empty descriptions on tools whose output isn't obvious from the name.
- Mismatches between schema and text, like `minimum: 0` beside "between 1 and 10".
- Rules enforced only by runtime errors. Move them into the schema (`enum`, `minItems`). Drop large `not`/`anyOf` blocks when the validator already rejects the call with a clear error.
- Inconsistency: `additionalProperties: false` missing on one tool, or one arg described two ways across tools.
- Machine-specific values baked into schema defaults, and doc comments that a schema patch overwrites before the model sees them.

### Outputs

- Empty, `null`, `false`, and constant fields. `{recorded: true}` becomes `{}`.
- Echoes of what the model sent or wrote: its own prompts, labels, names, or the site it is already on.
- Derived state. Mutually exclusive booleans become one `status`. `hasMore` goes when `nextCursor` is `null` exactly when there is no more.
- Internal fields the model never sends back or acts on, such as revisions, provider names, and event-log paths.
- Replays. Repeat reads such as polls and follow-ups return only what is new since the last read.
- Missing next steps. Return what the model needs for the next call, such as absolute paths, which also expose writes landing in the wrong checkout.
- Large results. Use one inline limit across tools, and save the overflow as a plain file the model can `grep`.

### Mechanisms

Prefer deleting a mechanism to documenting it.

- A tool that only lists static choices becomes an `enum` or a section in the run context, like skills are listed.
- Tools that differ by one arg merge into one. Rename a tool when its name misleads.
- Delete a stored type field when the file extension or another field already gives the type, and migrate existing data.
- A tool that is valid only in one rare turn becomes plain text in the reply, when a hook can parse it from there.
- Delete a feature that transcripts show almost no one uses, along with its schema text.

### Evidence from transcripts

For tools that fail often, have a subagent study past transcripts in `~/.sprocket/transcripts/` and report, without opening a PR: call and failure counts, failure causes ranked by count, and fixes ranked by failures prevented. Prefer fixes that replace a mechanism over parser leniency, since each leniency adds a rule. Your own tool results in the audit thread count as evidence too.
