# AGENTS.md

## Project Overview

- Sprocket is an agentic platform that streamlines robotics development.
- It's goal is to give its users and AI agents the best possible experience when developing robots and robot apps. They should be able to ship across the entire robotics stack much faster than ever before.
- Sprocket should work seamlessly across different hardware platforms, operating systems, and Sprocket's own cloud for robotics development.

## Testing

1. `cargo test`
2. `bun run test`
3. `bun convex dev --once in ./apps/web/` -> After every convex-related change
4. `bun run build`
5. `prek run -a` -> Always run this for ALL formatting and linting

Run only the tests relevant to your changes unless instructed otherwise.
If you are a subagent, don't run any of the above.

### Nix Environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in Order

1. Reliability of code -> Behavior should be predictable under load and during failures -> This includes our servers and the user's system
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make tradeoffs.

## Maintaining Code

- Don't be afraid to change existing code in order to improve on any of the priorities.
- Make sure that changes are made in all the layers of the app when needed.
- Deleting code, often fixes more problems than writing code does. Sometimes writing too much code introduces problems.
- Don't maintain backwards compatibility in any of the code unless explicitly asked. It's recommended to add temporary migration functions for the backend data instead.

## Writing Code

Specifically for gpt-5.6-sol: You often end up writing more code than needed, especially tests. Please don't do this.

## Dependency Documentation

- Most of what you know about our dependencies is outdated or wrong. Most of your training data contains obsolete APIs, deprecated patterns, and incorrect usage.
- Always check the documentation for the latest best practices.

## Subagents

### Working on Stuff - Only for Main Agents

- Feel free to commit, branch, and spin up worktrees as you please. Don't push before asking.
- For non bulk/mechanical/zero-brain operations, always get a subagent to review the code before considering the code as ready for a push.

#### PR Workflow

- Unless very specifically requested, PRs should be made only against the default branch.

1. When requested, push code and make a PR
2. Wait for the Greptile AI code review CI to complete and give its review on your changes.
3. Fix any relevant issues found by it:
   - These can be inline comments on the PR or somewhere above "Important Files Changed" in the PR description.
   - It often happens that some of the issues reported are false positives, outdated, not relevant, etc.
   - Don't spend any energy on these and skip them.
4. Commit and push the code -> this time without asking.
5. Loop on 2-4 till there are no more issues to fix.
6. Cleanup any worktrees and branches you created for this PR when you are done.

### Subagent Prompting

To main agents:

- Do the deep dives and figure out what needs to be done and delegate the rest accordingly to subagents.
- Don't put any parts of your system prompt, AGENTS.md, etc. in the subagent prompts.
- Tell the subagent that it is a subagent.
- The length of your prompt should not even be close to the amount of code the subagent will be writing. -> If this absolutely will be the case for a particular work, don't use a subagent for this work.

To subagents:

- Never create your own subagents.

### Picking the Right Models for Subagents

- Higher rankings = better. (higher ranking on the costs indicates lower cost of the model)
- Cost reflects what the model costs me from subscriptions, credits, tokens it uses, etc. not its actual list price.
- Intelligence shows how hard of a problem you can hand the model unsupervised.
- Taste covers UI/UX, code quality, and API design.

| model         | cost | intelligence | taste | reasoning to use |
| ------------- | ---- | ------------ | ----- | ---------------- |
| gpt-5.6-sol   | 8    | 9            | 6     | high             |
| fable-5       | 5    | 8            | 9     | high             |
| gpt-5.6-terra | 9    | 7            | 5     | high             |
| grok-4.5      | 10   | 6            | 7     | high, fast       |

How to apply:

- Only use the models listed above.
- If the model you want to use isn't available in your subagent tool, feel free to use the CLI of another coding agent harness.
- If a cheaper model's output doesn't meet the bar, rerun/redo the work with a better model without asking.
- Intelligence > taste > cost for actual work.
- The final output's quality is way more important than how much it costed. It costs much more to redo work than to do it right the first try.
- For bulk/mechanical/zero-brain operations, use the cheapest model first and only switch to a better model if the output doesn't meet the bar.
- For user-facing UI/UX and APIs, use a model with good taste (>=7). If making those UIs/APIs is highly complicated, get a model with higher intelligence to complete the work after the core UI/API has been decided by the model with good taste.
