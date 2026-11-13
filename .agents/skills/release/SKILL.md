---
name: release
description: Open a version bump PR and draft the GitHub release notes for it.
disable-model-invocation: true
---

# Release

The user names the new version. The previous version is the latest stable release (`gh release list --exclude-pre-releases --exclude-drafts -L 1`), so canary prereleases never become the baseline.

## 1. Version bump PR

1. Replace the previous version everywhere it names Sprocket's own version. In `Cargo.lock`, change only the `sprocket-*` packages. Other crates can share the version number.
2. Remove every `<Snippet file="unreleased.mdx" />` mark from `docs/` for features that ship in this release. Keep the snippet file for later features.
3. Open the PR with the title format and body of the last bump PR.

## 2. Release notes

Collect every commit in `v<previous>..origin/main`. Read PR bodies when a title doesn't say what users see, or when a PR might break older clients.

Write for users. Merge related PRs into one bullet that describes the change, followed by its PR links. Leave out refactors, dependency updates, CI, docs, tests, and internal chores unless users notice them. Use this layout, and follow the previous release's notes for bullet style and the rest of `Use it now`:

```markdown
## Use it now

(install snippet from README.md)

## What's changed

### Features added

### Performance improvements

### Fixes

### Upgrade notes

**Full Changelog**: https://github.com/spikonado/sprocket/compare/v<previous>...v<version>
```

Performance improvements holds every `perf` commit and any feature or fix whose effect is speed or cost, including ones whose titles have a different type. Upgrade notes holds breaking changes, such as a raised minimum client version. Drop sections that end up empty.

Save the notes as a Markdown artifact so the user can paste the raw text into the GitHub release. Then list any PRs you left out or could only describe by their title.
