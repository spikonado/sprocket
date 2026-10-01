# Vendored anti-slop

Source repository: https://github.com/dmmulroy/anti-slop.

Installed source and tests come from `src/` at commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The installed `install-anti-slop` skill's assets match that commit's production files byte-for-byte before repository formatting. This is the verified bundle revision, not a promise to track upstream HEAD.

The previous installation matches `src/` at commit `6d538555cb151d4121ed51a27db81890eacf8ae9` after applying this repository's Prettier configuration. Every existing TypeScript file was compared. No local behavioral changes or deletions were found. That recoverable revision was the merge base.

## Installed paths and policy

- Generic entry point: `tools/oxlint/anti-slop/index.ts`.
- Optional Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`. It remains unregistered because no workspace manifest directly depends on Effect.
- All 18 generic rules are enabled at error severity, including readable spacing and both array performance rules. Native `oxc/no-accumulating-spread` is also enabled at error severity. Existing ignores remain unchanged.
- Oxlint and `@oxlint/plugins` remain pinned to matching version `1.85.0`. The incoming source requires no dependency upgrade.

The update includes scoped and generic alias resolution, shared scope and parameter helpers, known-value call checks, safety-marker options and export-comment attachment, predicate-subject handling, undefined existence probes, and borrowed-member-name handling. All incoming rules and helpers are present, including array performance rules, readable spacing, and optional Effect rules. No incoming source changes remain deferred.

The enforcement migration fixes 4,366 readable-spacing findings in a separate whitespace-only commit. Single-pass array transformations replace the flagged filter/map chains without requiring iterator helpers in browser or npm-launcher runtimes. The cleanup preserves array order and sparse-array behavior, mandate ID validation, and last-result-wins Map entries. No rule suppressions or severity reductions were added.

## Intentional deviations

- TypeScript files use this repository's Prettier configuration. Compare formatted upstream files when recovering the base for a future update.
- `LICENSE` retains anti-slop's MIT notice. The nested Stylistic license and provenance record are retained separately under `vendor/eslint-stylistic/`.
- The spacing CLI test resolves the installed Oxlint binary and invokes it through Node instead of requiring pnpm.
- Local `package.json` declares ESM without changing the monorepo's module mode. `apps/web/tsconfig.anti-slop.json` checks all plugin code and tests with the web workspace's declared TypeScript and Node types. The root script delegates to the workspace command without depending on a compiler installation path.
- Root `test:anti-slop` runs all 24 upstream test files through Node's test runner and is included in `bun run test`. Root `check:anti-slop` typechecks the vendored code and is included in the pre-commit TypeScript check.
- Review fixes keep class-expression names local to the class, isolate generic substitutions across aliases, resolve interfaces by lexical scope, and restrict Effect catch advice to the handler's actual error binding. Regression tests cover these differences from the incoming revision.
- The nested Stylistic provenance record distinguishes upstream pnpm commands from Sprocket's Bun validation commands.

## Verification and recovery

Run `bun run test:anti-slop`, `bun run check:anti-slop`, `bun run lint:oxlint`, and `prek run -a` through the repository's Nix environment. The CLI test verifies spacing rejection, exact autofixes, and repeated-fix stability. Run a second explicit Prettier check on the vendored directory, which the application formatter intentionally ignores.

The vendored update passed all 24 plugin test files, the full root test command, root typechecking with TypeScript 7, application Oxlint, the web production build, explicit vendored formatting, and all `prek run -a` hooks.

Full-enforcement verification passed all 24 plugin test files, all 628 web tests with `vitest --run --maxWorkers=2`, 20 desktop tests, 40 npm tests, root and plugin typechecking, Oxlint with zero findings, Convex codegen using the configured development deployment, the web production build, explicit vendored formatting, and all `prek run -a` hooks. Both the whitespace migration and final source cleanup left files unchanged on a second autofix/formatter pass. Greptile reviewed the enforcement commit with 5/5 confidence and no actionable findings.

Default-concurrency root test attempts hit payment and app cold-start timeouts, then a Firecrawl fake-timer failure under load. Targeted reruns and the complete two-worker web run passed without source or timeout changes. The first concurrent hook run reported file changes while other migration commands were active; the isolated rerun passed every hook. Cargo check passed with an existing unused `CliRunSettings` import warning in the untouched Rust CLI.

The pre-update repository snapshot is retained outside the worktree at `/home/amronos/.sprocket/anti-slop-backup-85b5e6c`. Commit `85b5e6c` contains the previous files, configuration, and dependencies. The worktree was clean before this update. Keep this backup until the update is accepted.
