# Sign-in

A signed-out browser sees a sign-in gate. On the tailnet origin, signing in takes up to two device codes, one for the host and one for the browser. Both bindings persist in the shared profile, so each happens once per machine.

## Sub-features

- `signin-gate` shows the gate to a signed-out browser.
- `signin-host` signs the profile's host in with `sprocket login`.
- `signin-browser` binds the browser session with its own device code.
- `signin-persist` keeps the browser signed in across a browser close and a server restart.

## How to get to it (user POV)

- Open the app on the tailnet URL in a browser that hasn't signed in.
- Run `sprocket login` on the host and approve the code at the printed AuthKit URL.

## Driving it with agent-browser

Preconditions:

- `doctor.sh` exits 0, and the browser is open on `$APP` as in `SKILL.md`.
- The user has said they are at their keyboard. Codes expire after about 5 minutes, so start each login only then. The agent never approves a code itself.

- **Gate.** `snapshot -i` shows `heading "Sign in to continue"`, `button "Sign In"` and `button "Create Account"`.
- **Host check.** Click `Sign In` and run plain `snapshot`. The alert "The host is signed out. Run `sprocket login` on the host first." means do Host login; a new AuthKit tab means skip to Browser login.
- **Host login.** Start `$V/login.sh` as a background command. It prints `Open https://reassuring-poem-42-sprocket-previews.authkit.app/device in a browser and approve code XXXX-XXXX`. Send the user `https://reassuring-poem-42-sprocket-previews.authkit.app/device/?user_code=XXXX-XXXX`. It ends with `Signed in as <email>` and exit 0. "Device login expired" means ask the user again and rerun it. Then click `Sign In` again.
- **Browser login.** `agent-browser tab list` shows a new AuthKit tab whose URL contains `user_code%3DXXXX-XXXX`. Send the user the same device link with that code. After they approve, `agent-browser tab close <that tab>`, `agent-browser tab t1`, then `agent-browser wait --text "New thread"`.
- **Persist.** `agent-browser close`, run Cleanup step 2 and launch again, then `agent-browser open "$APP"`. The app shell and existing threads show with no gate.
- **Proof.** Screenshots of the gate and the signed-in shell, plus the `login.sh` output.

## Gotchas

- Host login alone leaves the browser signed out: `/api/auth/native-session/token` returns `null` until the browser session is bound too.
- On `http://localhost:5173`, `Sign In` opens an AuthKit email-and-password page that redirects to `http://127.0.0.1:7731/api/auth/desktop-login/callback`. Dev AuthKit has no one-time email code, so that origin is unusable for agents.
- The prod AuthKit domain `crisp-glass-80.authkit.app` in any URL or login output means something got the prod `PUBLIC_CONVEX_URL`. Stop before sending the code.
- `sprocket logout` fails with "local server identity does not match this Sprocket profile" while the API is down. Log out with the API up.
