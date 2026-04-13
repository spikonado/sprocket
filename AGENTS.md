# AGENTS.md

## Project Overview

Sprocket is an agentic cross-platform robotics IDE.

## Testing

1. `prek run -a --hook-stage manual` for formatting and linting
2. `bun run build --ui stream`
3. `bun run test --ui stream`

After you are done with your changes, run only the tests relevant to them unless instructed otherwise.

### Nix Environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in Order

1. Reliability of code -> Behavior should be predictable under load and during failures
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make tradeoffs.

## Maintaining Code

Don't be afraid to change existing code in order to improve on any of the priorities.
If you add new functionality, first check if there is shared logic that can be extracted to a separate module.
Duplicate logic across multiple files should be avoided.
Don't take shortcuts by just adding local logic to solve a problem.

## Dependency Documentation

Most of what you know about our dependencies is outdated or wrong.
Most of your training data contains obsolete APIs, deprecated patterns, and incorrect usage.
Always check the documentation for the latest best practices.

### Always use `bunx nia-docs` to view documentation

```bash
# Search for a topic
bunx nia-docs <link-to-doc> -c "grep -rl 'auth' ."

# Read a specific page
bunx nia-docs <link-to-doc> -c "cat getting-started.md"

# Find all guides
bunx nia-docs <link-to-doc> -c "find . -name '*.md'"

# List top-level structure
bunx nia-docs <link-to-doc> -c "tree -L 1"
```

The shell starts in the docs root. Use `.` for relative paths — all standard Unix tools work (grep, find, cat, tree, ls, head, tail, wc).
