# AGENTS.md

## Project Overview

Sprocket is an agentic platform that streamlines robotics development.
It's goal is to give its users and AI agents the best possible experience when developing robots and robot apps.
This includes microcontroller programming, ROS 2 development, simulation workflows, robot app creation, etc.
All of this should work seamlessly across different hardware platforms, operating systems, and Sprocket's own cloud for robotics development.

## Testing

1. `cargo test`
2. `bun run test`
3. `bun convex dev --once in ./apps/web/` -> After every convex-related change
4. `bun run build`
5. `prek run -a` -> Always run this for ALL formatting and linting

Run only the tests relevant to your changes unless instructed otherwise.

### Nix Environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in Order

1. Reliability of code -> Behavior should be predictable under load and during failures
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make tradeoffs.

## Maintaining Code

Don't be afraid to change existing code in order to improve on any of the priorities.
Make sure that changes are made in all the layers of the app when needed.
Don't maintain backwards compatibility in any of the code unless explicitly asked. It's recommended to add temporary migration functions for the backend data instead.

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
