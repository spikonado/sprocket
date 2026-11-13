---
name: deploying
description: 'Use when deploying a project, or checking, debugging, or configuring a deployment (logs, env vars, domains).'
---

If the project already deploys somewhere else, with a `fly.toml`, a `wrangler.toml`, a deploy script, or a CI deploy workflow, deploy that way and skip the rest of this skill.

Otherwise deploy with the Vercel connector's CLI, `vercel`, from the project's root.

## Set up the connector

- Check that Vercel is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it.
- Run `vercel whoami`. If you aren't logged in, ask the user to sign in on the Vercel connector, then wait. Leave `vercel login` and tokens to the user.
- Pass `--non-interactive` to every command, so a prompt fails with a message instead of waiting on input.
- Read `vercel <command> --help` before using a flag you haven't used in this run. The CLI changes often.

## Link the project

- Run `vercel link` when `.vercel/project.json` is missing. If the account belongs to more than one team, ask the user which team.
- Keep `.vercel` out of git. Check `.gitignore` after linking.
- In a monorepo, link and deploy from the app's directory, or check that the Vercel project's Root Directory points at the app.

## Deploy

1. Build locally first with the project's own build script. A build that fails on the machine fails on Vercel too, and local errors are faster to read.
2. Deploy a preview with `vercel deploy`.
3. Deploy to production only when the user asked for it. A project's first deployment is always production.
4. If the deployment fails, read its build logs with `vercel inspect <url> --logs`, fix the cause, and deploy again.
5. Check the deployed URL, then report it to the user. Vercel Authentication usually protects previews, so fetch them with `vercel curl` instead of turning protection off.

Git pushes to a repo connected to Vercel deploy on their own. When the project is connected, prefer pushing and following the deployment it starts.

## Environment variables

- Keep files written by `vercel env pull` out of git.
- Ask the user for secret values.
- Env var changes apply to new deployments only. Redeploy after changing them.

## Destructive actions

Ask the user before rolling back production or deleting projects, deployments, or domains. Deletions are permanent.
