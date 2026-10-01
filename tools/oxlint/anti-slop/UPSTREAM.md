# Vendored anti-slop

Source repository: https://github.com/dmmulroy/anti-slop.

Installed source and tests come from `src/` at commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The installed `install-anti-slop` skill's assets match that commit's production files byte-for-byte before repository formatting. This is the verified bundle revision, not a promise to track upstream HEAD.

The previous installation matches `src/` at commit `6d538555cb151d4121ed51a27db81890eacf8ae9` after applying this repository's Prettier configuration. Every existing TypeScript file was compared. No local behavioral changes or deletions were found. That recoverable revision was the merge base.

## Installed paths and policy

- Generic entry point: `tools/oxlint/anti-slop/index.ts`.
- Optional Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`. It remains unregistered because no workspace manifest directly depends on Effect.
- Existing enabled rules, error severities, and ignores remain unchanged. New implementations are exported but are not enabled without a policy decision.
- Oxlint and `@oxlint/plugins` remain pinned to matching version `1.85.0`. The incoming source requires no dependency upgrade.

The update includes scoped and generic alias resolution, shared scope and parameter helpers, known-value call checks, safety-marker options and export-comment attachment, predicate-subject handling, undefined existence probes, and borrowed-member-name handling. All incoming rules and helpers are present, including array performance rules, readable spacing, and optional Effect rules. No incoming source changes remain deferred.

## Intentional deviations

- TypeScript files use this repository's Prettier configuration. Compare formatted upstream files when recovering the base for a future update.
- `LICENSE` retains anti-slop's MIT notice. The nested Stylistic license and provenance record are retained separately under `vendor/eslint-stylistic/`.
- The spacing CLI test resolves the installed Oxlint binary and invokes it through Node instead of requiring pnpm.
- Local `package.json` declares ESM without changing the monorepo's module mode and exposes `typecheck`, which runs the workspace's TypeScript against the local `tsconfig.json`. That config checks all plugin code and tests with the workspace's Node types.
- Root `test:anti-slop` runs all 24 upstream test files through Node's test runner and is included in `bun run test`. Root `check:anti-slop` typechecks the vendored code and is included in the pre-commit TypeScript check.

## Verification and recovery

Run `bun run test:anti-slop`, `bun run check:anti-slop`, `bun run lint:oxlint`, and `prek run -a` through the repository's Nix environment. The CLI test verifies spacing rejection, exact autofixes, and repeated-fix stability. Run a second explicit Prettier check on the vendored directory, which the application formatter intentionally ignores.

Verification passed for all 24 plugin test files, the full root test command, root typechecking with TypeScript 7, application Oxlint, the web production build, explicit vendored formatting, and all `prek run -a` hooks. The first full test run timed out in an untouched payments test during concurrent Rust compilation. Its targeted rerun and the second full run passed without code changes.

The pre-update repository snapshot is retained outside the worktree at `/home/amronos/.sprocket/anti-slop-backup-85b5e6c`. Commit `85b5e6c` contains the previous files, configuration, and dependencies. The worktree was clean before this update. Keep this backup until the update is accepted.
