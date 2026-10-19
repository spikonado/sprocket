# Sprocket verification map

The maintained source for verifying Sprocket's user-facing web behavior. Read this index, then use the matching feature file as the recipe. Update a file when the UI it describes changes.

## Baseline preconditions

- `scripts/launch.sh` is running from this worktree and `scripts/doctor.sh` passes.
- The browser is open on `$APP` (the tailnet URL) with `AGENT_BROWSER_SESSION` and `AGENT_BROWSER_RESTORE` exported as in `SKILL.md`, and shows `button "New thread"`, not `Sign in to continue`.
- `scripts/scratch-repo.sh` has created `/tmp/verify-sprocket-scratch`. It has no git remote, so it never merges into an existing project of the same repository. It is already attached as project `verify-sprocket-scratch` in the dev account; select it rather than adding another directory.

## Driving conventions

- Prefer accessible names from `snapshot -i` over CSS selectors or coordinates. Take refs with `grep -o 'ref=e[0-9]*' | cut -d= -f2`.
- Use plain `snapshot` when you need alerts, banners, status text or errors.
- Re-snapshot after every action that changes the page. Refs from another tab or a reloaded page are stale.
- Mutate only the scratch project, and restore its files afterwards. The dev account is shared with the user's own testing, and projects can't be removed.

## Proof and skip reporting

- Save a screenshot and a `snapshot` text file before and after each action in `/tmp/verify-sprocket/<run-id>/`.
- Confirm each mutation in a second view: disk, `~/.sprocket-dev-verify/project-attachments.json`, network requests, or a page reload.
- Report an unreachable path with the command you ran and the unmet precondition. Don't report it as verified through another path.

## Features

- [Sign-in](./sign-in.md) covers the signed-out gate, host device login, and the loopback session.
- [Projects](./projects.md) covers adding a project from the empty state and the project menu, and switching projects.
- [Threads](./threads.md) covers starting a thread, a model reply, the inbox, and the transcript after reload.
- [Side panel](./side-panel.md) covers opening the panel, the view picker, tabs, and closing.
