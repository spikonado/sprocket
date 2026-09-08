# Artifact cutover

Production and preview workflows use `artifact-deploy.mjs` for the cloud artifact
artifact rollout. Run it instead of a direct Convex deploy on an existing
deployment:

```sh
bun scripts/artifact-deploy.mjs --message "Cloud artifacts with local bindings"
bun scripts/artifact-deploy.mjs --preview-name pr-123
```

Deployment selection follows the Convex CLI. Without a preview name, both deploy
and archive commands target production, or the deployment locked to
`CONVEX_DEPLOY_KEY`. `--env-file` paths resolve from `apps/web`. Preview keys need
an explicit `--preview-name`. The script rejects destructive preview recreation
and dry-run flags rather than risk running a migration against the wrong target.

The script deploys a temporary schema that accepts both artifact formats. The
old tool endpoints remain removed. It then archives legacy artifacts and every
stored version into `oldArtifacts`, preserving source IDs and thread ownership.
Each batch copies and deletes rows in one transaction. Rerunning resumes safely;
new cloud artifacts with opaque registration IDs stay untouched. Metadata without versions and
orphaned versions are archived too.

After the archive finishes, a second bounded pass checks every active row for
legacy metadata and confirms no versions remain. The script restores the final
schema and deploys it with type checking enabled. That schema contains the cloud `artifacts`
table and `oldArtifacts`, but no `artifactVersions` definition. Convex validation
rejects the final deploy if legacy metadata remains in the active table.

The script restores local schema source after a failed command or handled
interrupt. It also saves `schema.ts.artifact-backup` before staging. If a process
is killed without cleanup, inspect that backup and the current schema, restore
the original source from the backup, and remove the backup before rerunning.
An existing backup blocks another migration invocation. No production migration
runs as part of local tests or code generation.

The intermediate PR design with paths in Convex was not deployed. This cutover
therefore handles the released versioned schema, not that intermediate design.
Local file bindings are created by `add_artifact`, `edit_artifact`, and
`save_artifact`; the migration does not infer or create paths on user machines.
