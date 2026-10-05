---
name: cleanup
description: Clean up code in a PR, branch, or selected area. Use to remove unnecessary complexity, redundant tests, and obsolete compatibility code.
---

# Cleanup

Find and implement cleanup opportunities. Respect a review-only request. Keep changes that make the code easier to understand or maintain, even if they don't reduce its line count.

## Scope

Use the requested PR, branch, or area. Otherwise inspect the current changes and ask if the target is unclear. Code cleanup does not authorize deleting unrelated files or branches.

For a PR, read the whole diff against its merge base, not individual commits. Read the surrounding code, callers, and tests to understand the intended behavior before editing.

## Simplify

For each part, ask what needs it and what would break without it. Delete unnecessary code before adding abstractions.

Look for:

- Dead code, stale documentation, and unused dependencies.
- Duplicate state or logic. Share logic only when its behavior matches.
- Pass-through wrappers and extension points with no current need. Keep abstractions that hide complexity or clarify ownership.
- Custom code a dependency now supports. Verify the installed API before replacing it.
- Redundant checks and fallback paths. Keep validation at trust boundaries and handling for real failures.
- Comments that repeat the code and type assertions that hide modeling problems.

Preserve behavior, including errors, concurrency, and stored data. Ask before making behavior changes outside the requested scope. Update affected callers and remove helpers or tests that the cleanup leaves unused.

Remove compatibility for earlier PR revisions only after checking that no supported consumer or existing data needs it. Follow the project's release and migration policy for other compatibility code. Commit age alone does not prove a shim is obsolete.

## Tests

Keep tests for behavior and regressions. Prune tests that repeat constants, mirror implementation details, duplicate coverage, or test a dependency instead of the project's use of it. Before deleting a test, identify where its useful coverage remains or why the behavior no longer exists. Rewrite brittle tests when their coverage matters.

## Verify

Run relevant tests and the project's required checks. Re-read the final diff for behavior changes and leftovers. Report what changed, what you checked, and any failures. If nothing needs cleanup, say so.
