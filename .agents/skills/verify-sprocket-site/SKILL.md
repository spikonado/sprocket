---
name: verify-sprocket-site
description: Verify changes to Sprocket's marketing site, `apps/site` (home, pricing, share images), in its Astro dev server against the dev Convex deployment with analytics off, driven with agent-browser. Use to prove a site change works, or when the user asks for site screenshots or a tailnet URL for the site.
---

# Verify the Sprocket site

Proof comes from the real site. Run `astro dev` from this worktree against the dev Convex deployment with PostHog off, drive it the way a visitor does, and show from network logs that nothing reached prod.

## Helpers

Start every shell with these. The helper scripts call `agent-browser` too, and the session name keeps this browser apart from `verify-sprocket`'s cookies and tabs.

```sh
S=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket-site/scripts
R=$S/../../verify-sprocket/scripts/ref.sh
export AGENT_BROWSER_SESSION=verify-sprocket-site
```

| Command                  | Does                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `$S/launch.sh`           | Runs `astro dev` on port 4335 in the foreground with the dev environment and a server request log.                |
| `$S/doctor.sh`           | Read-only health check. Exit 0 means the instance is worth driving.                                               |
| `$S/hide-dev-toolbar.sh` | Removes Astro's dev toolbar from the open page. Run it after every navigation.                                    |
| `$S/net-check.sh <OUT>`  | Turns `<OUT>/browser.har` and the server's request log into request lists in `<OUT>`. Exit 1 on any prod request. |
| `$S/site-url.sh`         | Prints a tailnet URL for the dev server.                                                                          |
| `$S/stop.sh`             | Stops this worktree's server and removes its tailnet mapping.                                                     |
| `$R '<text>'`            | Prints the `@ref` of the first `snapshot -i` line containing the text.                                            |

## Machine facts

- One site instance runs per machine. While another worktree's instance is up, `launch.sh` prints `Ports in use` and waits. Keep that session running and poll it every few minutes, and leave the other instance running. Ask the user only when it stays taken for over an hour.
- Ports `4321` and `17731` and their tailscale serve mappings belong to the user, and `5173` and `7731` belong to `verify-sprocket`. Leave them all alone.
- The shell exports the prod `PUBLIC_POSTHOG_KEY` and `PUBLIC_CONVEX_URL`, and `launch.sh` overrides them. A gitignored `apps/site/.env` overrides `launch.sh` in turn, so look there when `doctor.sh` reports prod values.
- The server request log normally holds `api.github.com` (latest release), the dev Convex host, and `registry.npmjs.org` (Astro's update check).

## Launch

Start `$S/launch.sh` as a background command session and keep its id. It is ready once `$S/doctor.sh` exits 0.

Edits under `apps/site/src` hot-reload, so keep the server running across edits.

## Doctor

Run `$S/doctor.sh` before the first drive, after any failed drive, and whenever anything looks off. Drive only after exit 0.

## Open the site

```sh
agent-browser network har start --content none
agent-browser open http://localhost:4335/
agent-browser set viewport 1440 900
agent-browser wait --text "The best AI agent"
$S/hide-dev-toolbar.sh
agent-browser snapshot -i -u
```

- Start the HAR before the first `open`. `network requests` lists only the current page and empties when the browser restarts, while the HAR keeps every request of the run.
- Do the desktop pass first, since `agent-browser set device "iPhone 14"` stays set until `agent-browser close`.
- When the user wants to look, give them `$($S/site-url.sh)` and keep driving `localhost` yourself.

## Drive

Read [features/README.md](features/README.md), the index of one recipe per feature, before driving. React islands hydrate after the HTML shows, so `wait --text` for text an island renders before clicking it.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket-site/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file.

- Before and after each visitor action, run `agent-browser screenshot $OUT/NN-step.png` and `agent-browser snapshot > $OUT/NN-step.txt`.
- Every run ends with `agent-browser network har stop $OUT/browser.har` and `$S/net-check.sh $OUT`. Its exit 0 proves that no analytics or prod Convex request left the browser or the server. Keep its output in the report. The server log it copies covers everything since launch, not only this feature.
- Open each screenshot and generated image with `parse_file` before describing it. It rejects full-page screenshots taken at `iPhone 14`'s 3x scale, so shrink those first with the `cwebp` command below and `-resize 600 0`.
- Drive only the visitor path: clicks, keys and URLs a visitor can reach. Fetch generated images with `curl` from `localhost:4335`, since that is how crawlers reach them.
- Share images as WebP: `nix shell nixpkgs#libwebp -c cwebp -quiet -q 70 -resize 1400 0 in.png -o out.webp`.

## Cleanup

Stop only what this run started.

1. `agent-browser close`.
2. Terminate the launch command session, then run `$S/stop.sh`.
3. Keep `/tmp/verify-sprocket-site/`. It holds the evidence and the server request logs.

Run cleanup after failed attempts too, so the next launch finds the port and lock free.

## Known limits

- `/sitemap-index.xml`, the CSP headers and the Vercel adapter's output exist only in `astro build` output, so dev lacks them. Checking them needs `bun run --cwd apps/site build` with the same environment as `launch.sh`, which this skill does not cover.
- The redirects and rewrites in `apps/site/vercel.json`, such as `/docs`, run only on Vercel, as do `scripts/vercel-build.sh` and the preview and production deployments.
