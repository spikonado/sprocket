---
name: cleanup
description: Cleanup code in a PR, branch, or specified area. Use when asked to implement simplifications, remove over-engineering, prune redundant tests, or retire obsolete compatibility code. Not for deleting worktrees, branches, or user files.
---

# Cleanup

Make the intended behavior easier to understand and maintain, with fewer moving parts. Implement worthwhile changes rather than stopping at a list of suggestions; respect an explicit review-only request. Reliability comes before brevity. A clean result may need no changes.

## 1. Establish the scope

- Read applicable repository instructions and inspect Git status, worktrees, and the target PR or branch before editing. Preserve unrelated work and use an isolated worktree when required. If existing edits conflict with the cleanup, ask how to handle them.
- Use the PR or area named by the user. Otherwise use the current branch's open PR, then its branch diff or local changes. If the target remains ambiguous, ask; a bare `$cleanup` is not permission for a repository-wide rewrite or filesystem housekeeping.
- For a PR, inspect the **entire current diff against its base**, using the merge base, plus relevant local changes. Individual commits explain history; they are not separate cleanup scopes.
- Read the surrounding implementation, callers, tests, and contracts across affected layers. Establish what the feature is supposed to do and which released clients or stored data it must still support.

Proceed once the target, intended behavior, and compatibility boundaries are clear.

## 2. Question necessity

For each changed subsystem, ask: **What requirement does this serve? What breaks if it disappears? Can an existing mechanism do it instead?** Prefer deletion first, simplification second, abstraction only when it earns its cost.

Look for:

- Dead code, stale documentation, unused dependencies, redundant state, derived values stored separately, and duplicate sources of truth.
- Redundant fields echoed in tool outputs, status variants with no consumer, repeated unchanged-state reads or writes, and timers or polling that serve no live requirement. Keep useful observability and actionable errors.
- Pass-through wrappers, single-use abstractions, speculative extension points, configuration for nonexistent consumers, and fallback chains without a supported case.
- Duplicate lifecycle, polling, cancellation, error-handling, or UI logic. Share code when the semantics really match; keep distinct policies explicit instead of building a generic framework to hide their differences.
- Hand-rolled behavior now covered by a dependency. Check the installed version's documentation or source before replacing it with a native API.
- Defensive checks at already-validated internal boundaries, type assertions that conceal a modeling problem, and swallowed errors or fabricated success values. Keep validation at trust boundaries and explicit handling for real failures.
- UI state, explanatory copy, or confirmation steps with no user purpose. Preserve the intended interaction; get agreement before changing user-visible behavior rather than calling it a refactor.
- Comments that narrate code, unnecessary indirection, and dense expressions that save lines at the expense of clarity. Prefer clear names and straightforward control flow; retain explanations of non-obvious constraints.

### Compatibility is about consumers, not commit history

Separate compatibility for released versions and existing data from compatibility for superseded implementations within the same unshipped PR. Remove revision-only shims and their obsolete tests once no supported consumer or stored format needs them. Check release history, deployment state, and migration requirements rather than inferring this from when the code was committed.

Keep required compatibility under the repository's policy, document its removal gate in the repository's compatibility record, and include any required migration with the change. If a gate has passed, remove the shim and update its record together. Ask when release or data-retention requirements are unclear.

Complete the audit with concrete candidates and the behavior each must preserve. Mention significant over-engineering directly; avoid a separate planning ceremony for obvious, low-risk changes.

## 3. Implement a coherent cleanup

- Apply small, explainable changes across all affected layers. Update callers, types, schemas, documentation, and generated artifacts through their normal mechanisms where needed.
- Preserve observable behavior, including errors, ordering, cancellation, resource ownership, persistence and retention, and concurrency guarantees. Isolate behavior-changing fixes and obtain agreement when they exceed the requested scope.
- After removing a path, follow its references to remove newly orphaned helpers, dependencies, tests, and documentation. A text search alone is not proof that a public API or dynamically registered handler is unused.
- Keep helpers that clarify ownership, policy, or a meaningful operation. Inline helpers that merely rename an expression. Judge the result by concepts and coupling, not a line-count target.
- Re-read the resulting full diff for accidental behavior changes and leftovers. Stop when each candidate is implemented or has a concrete reason to remain; repeated passes should not manufacture work.

## 4. Keep tests that earn their cost

Retain tests for observable contracts, meaningful failure handling, regressions, concurrency, and migrations. Prefer behavioral assertions that survive a refactor.

Prune tests that only restate constants, mirror implementation steps, test a dependency rather than this project's integration, duplicate another test's coverage, or protect a removed revision-only path. Before deleting a test, identify the contract it covered and where that contract remains covered or why it no longer exists. Rewrite a useful but brittle test instead of discarding its protection. Add targeted tests only for a real coverage gap or changed contract.

Run the smallest relevant checks first, then the repository-prescribed lint, formatting, and test checks within its local execution limits. Report blocked or pre-existing failures accurately; a cleanup is not justification to bypass a failing check.

## 5. Finish the work

Follow the repository's commit and PR workflow. Update the existing PR when that is the target; create a separate PR when appropriate. Before pushing, check whether the remote head has advanced and incorporate concurrent changes without overwriting them. Follow configured review and CI requirements, fixing actionable findings and explaining dismissed ones.

Summarize what was removed or simplified, why retained complexity is necessary, any behavior or compatibility changes, and the checks run. Link the PR when applicable. Remove only temporary worktrees, branches, or research material created for this task once the work is safely preserved and repository policy calls for cleanup; leave unrelated resources alone.
