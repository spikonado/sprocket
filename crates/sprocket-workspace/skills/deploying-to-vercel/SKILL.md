---
name: deploying-to-vercel
description: 'Use when deploying a project to Vercel, or checking, debugging, or configuring a Vercel deployment (logs, env vars, domains).'
---

Deploy with the Vercel CLI, `vercel`, from the project's root.

## Set up the connector

- Check that Vercel is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it in Settings → Connectors.
- Run `vercel whoami`. If it says you aren't logged in, ask the user to sign in to Vercel in Settings → Connectors, then wait. Leave `vercel login` and tokens to the user.
- Pass `--non-interactive` to every command, so a prompt fails fast with a message instead of waiting on input.
- Read `vercel <command> --help` before using a flag you haven't used in this run. The CLI changes often.

## Link the project

- `.vercel/project.json` means the directory is already linked. Deploy from there.
- Otherwise run `vercel link --yes`. If the account belongs to more than one team, ask the user which team, then pass `--scope <team>`.
- Keep `.vercel` out of git. `vercel link` adds it to `.gitignore`; check that it did.
- In a monorepo, link and deploy from the app's directory, or check the project's Root Directory with `vercel project inspect`.

## Deploy

1. Build locally first with the project's own build script. A build that fails on the machine fails on Vercel too, and local errors are faster to read.
2. Run `vercel deploy --non-interactive` for a preview. Stdout is the deployment URL.
3. Deploy to production with `--prod` only when the user asked for production. A project's first deployment is always production.
4. If the deployment fails, read `vercel inspect <url> --logs`, fix the cause, and deploy again.
5. Check the deployed URL: fetch it, or open it in the browser. Report the URL to the user.

Git pushes to a repo connected to Vercel deploy on their own. When the project is connected, prefer pushing and let Vercel build, and use `vercel ls` or `vercel inspect` to follow it.

## Environment variables

- `vercel env ls` lists them per environment: production, preview and development.
- `vercel env pull .env.local` writes the development values for local builds. Keep that file out of git.
- Add values with `vercel env add <name> <environment>`, piping the value on stdin. Ask the user for secret values.
- Env var changes apply to new deployments only. Redeploy after changing them.

## Other tasks

- Runtime logs: `vercel logs <url>`.
- Domains: `vercel domains ls`, and `vercel alias set <url> <domain>` to point a domain at a deployment.
- Roll back production: `vercel rollback <url>`. Confirm with the user first.
- Deleting projects, deployments or domains is permanent. Ask the user first.
