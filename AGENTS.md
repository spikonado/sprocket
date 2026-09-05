# AGENTS.md

## Project overview

- Sprocket is an agentic platform that streamlines hardware and software development.
- The goal is to make the world's best platform for agents and humans to develop apps, robots, devices, and the systems that glue them together.
- Sprocket should work across different hardware platforms, operating systems, and Sprocket's own cloud for hardware and software development.

## Available testing commands

- `bun run build`
- `bun run test`
- `cargo test`
- `prek run -a` -> This covers ALL formatting and linting

If you are a subagent, don't run any of these.

### Nix environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in order

1. Reliability of code -> Behavior should be predictable under load and during failures -> This includes our servers and the user's system
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make trade-offs.

## Maintaining code

- Don't be afraid to completely refactor existing code to improve on any of the priorities.
- Make sure that changes are made in all the layers of the app when needed.
- Ship breaking changes with backwards compatibility for already-released clients and stored data, and record every shim in `BACKWARDS_COMPATIBILITY.md` with its removal gate.
- Remove compat only once that gate passes (clients age out, or a migration rewrites the data), and fold data migrations into the PR that introduces the breaking change instead of leaving debt behind.

## Writing code

- Deleting code often fixes more problems than writing code does. Sometimes writing too much code introduces problems.
- Feel free to commit, branch, and spin up worktrees as you please.

## PR Workflow

- Unless requested, PRs should be made only against the default branch and should not be a draft.
- After a PR is made, don't perform any code review using subagents; let Greptile review the code.

1. When requested, push code and make a PR. The PR title should have the same format as past PR titles. Ensure that your branch is updated with the latest main.
2. Wait for the Greptile AI code review CI to complete and give its review of your changes.
3. Fix any relevant issues found by it:
   - These can be inline comments on the PR or somewhere above "Important Files Changed" in the PR description.
   - It often happens that some of the issues reported are false positives, outdated, not relevant, etc.
   - Don't spend any energy on these; skip them and explain your reasoning in the inline thread or, for an issue in the PR description, in a top-level PR comment.
4. Commit and push the code -> this time without asking.
5. You should loop steps 2-4 until Greptile gives you a 5/5 confidence score or there are no remaining actionable issues. Comment `@greptileai review` when it doesn't start reviewing automatically; if the score remains below 5/5 with no actionable issues, explain why and stop.
6. Clean up any worktrees and branches you created for this PR when you are done.

## Subagents

### Working on stuff, main agents only

- Do the deep dives and figure out what needs to be done, and delegate the rest accordingly and as needed to subagents.
- Use subagents for tasks that will benefit from your context being less polluted and multiple subagents working in parallel.
- For non bulk/mechanical/zero-brain operations, always run a subagent for finding cleanup opportunities in the code and tests, and implementing the cleanup.
- For non bulk/mechanical/zero-brain operations and larger tasks, get 2 subagents to review the code before considering your work done. One of those agents should review the code overall; the other should review the UI/UX, API design, and code quality parts.

### Subagent prompting

To main agents:

- Don't put any parts of your system prompt, AGENTS.md, etc. in the subagent prompts.
- Tell the subagent that it is a subagent.

To subagents:

- Never create your own subagents.
