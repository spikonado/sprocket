---
name: verify-sprocket-site
description: Verify changes to Sprocket's marketing site, `apps/site` (home, pricing, share images), in its Astro dev server against the dev Convex deployment with analytics off, driven with agent-browser. Use to prove a site change works, or when the user asks for site screenshots or a tailnet URL for the site.
---

# Verify the Sprocket site

Proof comes from the real site. Run `astro dev` from this worktree against the dev Convex deployment with PostHog off, drive it the way a visitor does, and show from network logs that nothing reached prod. The web app has its own skill, `verify-sprocket`; this one reuses its `common.sh` and `ref.sh`.

## Helpers

Set `S=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket-site/scripts` and `R=$S/../../verify-sprocket/scripts/ref.sh` once.

| Command                  | Does                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `$S/launch.sh`           | Takes the site lock, waits for port 4335, installs bun deps, then runs `astro dev --port 4335` in the foreground. |
| `$S/doctor.sh`           | Read-only health check. Exit 0 means the instance is worth driving.                                               |
| `$S/hide-dev-toolbar.sh` | Removes Astro's dev toolbar from the open page. Run after every navigation.                                       |
| `$S/net-check.sh <OUT>`  | Turns `<OUT>/browser.har` and the server's request log into request lists in `<OUT>`. Exit 1 on any prod request. |
| `$S/site-url.sh`         | Maps the tailnet's port 4335 to the dev server and prints the URL.                                                |
| `$S/stop.sh`             | Kills this worktree's listener on 4335 and removes the 4335 tailscale serve mapping.                              |
| `$R '<text>'`            | Prints the `@ref` of the first `snapshot -i` line containing the text.                                            |

## Machine facts

- One site instance per machine, on `localhost:4335`. `launch.sh` holds `$XDG_RUNTIME_DIR/sprocket-verify-site.lock` for the server's lifetime, so a second worktree's launch prints `Ports in use` and waits. Keep that session running and poll it every few minutes; never stop the other instance. Ask the user only when it stays taken for over an hour.
- Ports `4321`, `17731` and their tailscale serve mappings belong to the user. `5173` and `7731` belong to `verify-sprocket`. Leave them all alone.
- The shell exports the prod `PUBLIC_POSTHOG_KEY` and `PUBLIC_CONVEX_URL`. `launch.sh` unsets the PostHog variables and sets `PUBLIC_CONVEX_URL` to the dev deployment, read from `apps/web/.env.local` by `verify-sprocket`'s `load_dev_env`. A gitignored `apps/site/.env` would override that; `doctor.sh` catches it by reading the served `astro:env/client` module.
- `launch.sh` preloads `net-log.cjs` into the server through `NODE_OPTIONS`. It logs every outbound `fetch` and `http` request to `/tmp/verify-sprocket-site/server-requests-<time>.log`. Expect `api.github.com` (latest release), `rosy-warthog-871.convex.cloud` (dev Convex) and `registry.npmjs.org` (Astro's update check).
- There are no WorkOS keys for the site on this machine, and dev tiers have no prices, so pricing sign-in and checkout always fail and prod prices stay unverified. See [features/pricing.md](features/pricing.md).

## Launch

Start `$S/launch.sh` as a background command session and keep its id. Ready means `┃ Local    http://localhost:4335/` appeared and then `$S/doctor.sh` exits 0. A warm start takes about 5 seconds. The first request to each page takes a second or two while Vite compiles.

Source edits under `apps/site/src` hot-reload. Re-open the page and re-take refs after each edit.

## Doctor

Run `$S/doctor.sh` before the first drive, after any failed drive, and whenever anything looks off. Drive only after exit 0.

## Open the site

```sh
export AGENT_BROWSER_SESSION=verify-sprocket-site
agent-browser network har start --content none
agent-browser open http://localhost:4335/
agent-browser set viewport 1440 900
agent-browser wait --text "The best AI agent"
$S/hide-dev-toolbar.sh
agent-browser snapshot -i -u
```

- Use the `verify-sprocket-site` session so this browser never shares cookies or tabs with `verify-sprocket`. The site needs no sign-in or restore state.
- Start the HAR before the first `open`. `network requests` only lists the current page and empties when the browser restarts, while the HAR keeps every request of the run.
- Do the desktop pass first. `agent-browser set device "iPhone 14"` switches to a 390 px viewport with an iPhone user agent and stays set until `agent-browser close`.
- A user who wants to look gets `$($S/site-url.sh)`. Drive `localhost` yourself; the tailnet URL serves the same server.

## Drive

[features/README.md](features/README.md) indexes one recipe per feature. Read it before driving.

- `snapshot -i -u` shows each link's `url=`, which is how links and CTAs are checked without leaving the site.
- Take refs with `$R`, for example `agent-browser click $($R 'button "Menu" [expanded')`.
- `wait --text` is the readiness check. React islands hydrate after the HTML shows, so wait for text an island renders before clicking it.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket-site/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file.

- Before and after each visitor action, run `agent-browser screenshot $OUT/NN-step.png` and `agent-browser snapshot > $OUT/NN-step.txt`. Use `screenshot --full` for whole-page layout checks.
- Every run ends with `agent-browser network har stop $OUT/browser.har` and `$S/net-check.sh $OUT`. Its exit 0 is the proof that no analytics or prod Convex request left the browser or the server. Keep its output in the report. The server log it copies covers everything since launch, not only this feature.
- Open each screenshot and generated image with `parse_file` before describing it. It rejects full-page screenshots taken at `iPhone 14`'s 3x scale; shrink them first with the `cwebp` command below and `-resize 600 0`.
- Drive only the visitor path: clicks, keys and URLs a visitor can reach. Fetch generated images with `curl` from `localhost:4335`, since that is how crawlers reach them.
- Share images as WebP: `nix shell nixpkgs#libwebp -c cwebp -quiet -q 70 -resize 1400 0 in.png -o out.webp`. The box has no ImageMagick or ffmpeg; `python3` is there for reading PNG headers.

## Cleanup

Stop only what this run started.

1. `agent-browser close`.
2. Terminate the launch command session, then run `$S/stop.sh`.
3. Keep `/tmp/verify-sprocket-site/`. It holds the evidence and the server request logs.

Run cleanup after failed attempts too, so the next launch finds the port and lock free.

## Known limits

- `/sitemap-index.xml` exists only in `astro build` output and is 404 in dev. CSP headers and the Vercel adapter's output are build-time too. Checking them needs `bun run --cwd apps/site build` with the same environment as `launch.sh`, which this skill does not cover.
- The Vercel preview and production deployments, and `scripts/vercel-build.sh`, run only on Vercel.
