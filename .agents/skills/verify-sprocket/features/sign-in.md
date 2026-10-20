# Sign-in

A signed-out browser sees a sign-in gate. On the tailnet origin, signing in takes up to two device codes, one for the host and one for the browser. Both bindings persist in the shared profile, so each happens once per machine.

## Sub-features

- `signin-gate` shows the gate to a signed-out browser.
- `signin-host` signs the profile's host in with `sprocket login`.
- `signin-browser` binds the browser session with its own device code.
- `signin-cancel` closes the device-code dialog and returns to the gate.
- `signin-persist` keeps the browser signed in across a browser close and a server restart.

## How to get to it (user POV)

- Open the app on the tailnet URL in a browser that hasn't signed in.
- Run `sprocket login` on the host and approve the code at the printed AuthKit URL.

## Driving it with agent-browser

Preconditions:

- `doctor.sh` exits 0, and the browser is open on `$APP` as in `SKILL.md`.
- The user has said they are at their keyboard. Codes expire after about 5 minutes, so start each login only then. The agent never approves a code itself.
- To check the gate on an already signed-in machine, use a throwaway session: `AGENT_BROWSER_SESSION=verify-sprocket-gate` with `AGENT_BROWSER_RESTORE` unset. Stop at the dialog, choose `Cancel`, and `agent-browser close` it.

- **Gate.** `snapshot -i` shows `heading "Sign in to continue"`, `button "Sign In"` and `button "Create Account"`.
- **Host check.** Click `Sign In`, then plain `snapshot` on the app tab. The overlay may say `Preparing sign-in` until `/desktop-login/start` returns. If the host is signed out, that request fails before `window.open`, there is no AuthKit tab, and the gate shows the alert "The host is signed out. Run `sprocket login` on the host first." Do Host login. If the host is signed in, an AuthKit tab opens and agent-browser focuses it; `agent-browser tab list` then `agent-browser tab t1` returns to `dialog "Finish signing in"`. Skip to Browser login.
- **Host login.** Start `$V/login.sh` as a background command. It prints `Open https://reassuring-poem-42-sprocket-previews.authkit.app/device in a browser and approve code XXXX-XXXX`. Send the user `https://reassuring-poem-42-sprocket-previews.authkit.app/device/?user_code=XXXX-XXXX`. It ends with `Signed in as <email>` and exit 0. "Device login expired" means ask the user again and rerun it. Then click `Sign In` again.
- **Browser login.** `dialog "Finish signing in"` shows the device link `https://reassuring-poem-42-sprocket-previews.authkit.app/device?user_code=XXXX-XXXX` as text, with `button "Open browser"`, `button "Copy link"` and `button "Cancel"`. Send the user that link. After they approve, close the AuthKit tab from `agent-browser tab list` and run `agent-browser wait --text "New thread"`.
- **Cancel.** In the dialog, `agent-browser press Escape` or click `button "Cancel"`. The gate returns with `button "Sign In"`, and the next click starts a new code.
- **Persist.** `agent-browser close`, run Cleanup step 2 and launch again, then `agent-browser open "$APP"`. `button "New thread"` with no gate is the signed-in proof. `region "Unsettled"` is omitted when it has no rows. A `fetch('/api/auth/native-session/token', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"forceRefreshToken":false}'})` in `eval --stdin` returns an object with `user.email`, not `null`.
- **Proof.** Screenshots of the gate, the dialog and the signed-in shell, plus the `login.sh` output.

## Gotchas

- `signin-host` and `signin-browser` need the user to approve a code. On a machine already signed in, report them as unreachable unless the user offers to approve.
- Host login alone leaves the browser signed out. `/api/auth/native-session/token` returns `null` until the browser login binds the session too.
- The dialog says "Preparing sign-in" until the link arrives, and "Open the sign-in link" when the popup was blocked. Re-snapshot before reading the link.
- The prod AuthKit domain `crisp-glass-80.authkit.app` in any URL or login output means something got the prod `PUBLIC_CONVEX_URL`. Stop before sending the code.
- An approval from a different account than the host's fails with "Sign in with the same account used by `sprocket login` on the host."
