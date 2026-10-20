---
name: release
description: Open a version bump PR and draft the GitHub release notes for it.
disable-model-invocation: true
---

# Release

The user names the new version. The previous version is the latest tag (`gh release list -L 1`).

## 1. Version bump PR

1. Branch from the latest `origin/main` in a new worktree.
2. Replace the previous version everywhere it names Sprocket's own version. `git log -i --grep='bump version'` finds past bump commits, and `git grep` for the previous version finds the current spots. In `Cargo.lock`, change only the `sprocket-*` packages. Other crates can share the version number. Bump the `-dev.` version in the npm release workflow too.
3. Run `bun install --frozen-lockfile` if the worktree has no `node_modules`, then `prek run -a`.
4. Open the PR titled `chore(release): Bump version to v<version>`. Use the body of the last bump PR as the template.

## 2. Release notes

Collect every commit in `v<previous>..origin/main`. Read PR bodies when a title doesn't say what users see, or when a PR might break older clients.

Write for users. Merge related PRs into one bullet that describes the change, followed by its PR links. Leave out refactors, dependency updates, CI, docs, tests, and internal chores unless users notice them. Match the layout of the last large release (v0.4.0 is the model):

```markdown
## Use it now

(install snippet copied from the previous release)

## What's changed

### Features added

### Performance improvements

### Fixes

### Upgrade notes

**Full Changelog**: https://github.com/spikonado/sprocket/compare/v<previous>...v<version>
```

Performance improvements holds every `perf` commit and any feature or fix whose effect is speed or cost, including ones whose titles have a different type. Upgrade notes holds breaking changes, such as a raised minimum client version. Drop sections that end up empty.

Save the notes as a Markdown artifact so the user can paste the raw text into the GitHub release. Then list any PRs you left out or could only describe by their title.
