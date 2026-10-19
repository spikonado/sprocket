# Sign-in

A signed-out user sees a sign-in gate. On the tailnet origin, signing in takes two device codes: one for the host (`sprocket login`) and one for the browser. Both bindings persist in the shared profile.

## Sub-features

- `signin-gate` shows the gate to a signed-out browser.
- `signin-host` signs the host in with `sprocket login`.
- `signin-browser` binds the browser session with a second device code.
- `signin-persist` keeps the browser signed in across a browser close and a server restart.

## How to get to it (user POV)

- Open the app on the tailnet URL with a new browser profile.
- Run `sprocket login` on the host and approve the code at the printed AuthKit URL.

## Driving it with agent-browser

Preconditions:

- `doctor.sh` passes and `$APP` returns 200.
- The user is at their keyboard, ready to approve each code within about 5 minutes.

- **Gate.** `agent-browser open "$APP"` then `agent-browser snapshot -i`. It shows `heading "Sign in to continue"`, `button "Sign In"` and `button "Create Account"`.
- **Host.** Click `Sign In` and run plain `snapshot`. If the alert says the host is signed out, run `scripts/login.sh` as in `SKILL.md`. It ends with `Signed in as <email>`.
- **Browser.** Click `Sign In`. `agent-browser tab list` shows a new tab whose URL contains `user_code%3DXXXX-XXXX`. After the user approves, close that tab, run `agent-browser tab t1`, then `agent-browser wait --text "New thread"`.
- **Persist.** `agent-browser close`, terminate the launch session, run `scripts/stop.sh` and `scripts/launch.sh`, then `agent-browser open "$APP"`. The app shell and existing threads show without a gate.
- **Proof.** Screenshot the gate and the signed-in shell. Save the `login.sh` output.

## Gotchas

- On `http://localhost:5173`, `Sign In` opens an AuthKit email/password page with `redirect_uri=http://127.0.0.1:7731/api/auth/desktop-login/callback`. Dev AuthKit asks for a password, not a one-time code. Never use this path.
- Host login alone does not sign the browser in: `/api/auth/native-session/token` returns `null` until the browser session itself is bound.
- A prod AuthKit domain (`crisp-glass-80.authkit.app`) in any URL or login output means something got the prod `PUBLIC_CONVEX_URL`. Stop, and don't send the code.
- `sprocket logout` fails with "local server identity does not match this Sprocket profile" when the API isn't running. Log out with the API up.
