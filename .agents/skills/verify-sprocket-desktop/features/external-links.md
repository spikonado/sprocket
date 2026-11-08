# External links

Links that open a new window leave the app for the system browser, and only `https` ones. Navigations of the window itself to another origin are blocked, so the window always shows the app.

## Sub-features

- `links-https` sends a new-window `https` URL to `xdg-open` and opens no Electron window.
- `links-refuse` drops non-`https` new-window URLs and logs `Only https URLs can be opened externally.`
- `links-guard` keeps the window on `http://localhost:5173` when the page tries to navigate elsewhere.

## How to get to it (user POV)

- Choose any control that opens a page in a new tab, such as `Open browser` in the sign-in dialog or a link in Settings.

## Driving it with agent-browser

Preconditions:

- The app is open as in `SKILL.md`. The signed-out gate is enough, because `Open browser` in the sign-in dialog is a `window.open` path.

- **Https link.** Drive [sign-in.md](./sign-in.md)'s Hand-off and Open browser steps. The second `opened-urls.log` line comes from the window-open handler. `agent-browser tab list` shows no new window, and `curl -s localhost:9393/json/list` lists no `authkit.app` page.
- **Guard.** `agent-browser eval "location.href = 'https://example.com'"`, then `agent-browser get url` still returns `http://localhost:5173/`. This is a probe of the guard, not a user path; label it so in the proof.
- **Refuse.** `agent-browser eval "window.open('http://example.com', '_blank')"`. The launch output shows `Failed to open external URL` with `Only https URLs can be opened externally.`, and `opened-urls.log` gains no line. Also a probe.
- **Proof.** The log lines, `tab list` output and the URL before and after each probe.

## Gotchas

- `agent-browser click --new-tab` makes its own CDP target and bypasses the handler. Click normally.
- The guard and refuse probes are drafted from `main.mjs` and have not been run yet.
