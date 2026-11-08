# Sign-in

A signed-out window shows the sign-in gate. `Sign In` asks the local server for an AuthKit link, hands it to the system browser and waits; AuthKit then redirects to the server's loopback callback. The window's session cookie lives in `~/.sprocket-dev-verify-desktop`, so a sign-in persists across launches.

## Sub-features

- `desktop-gate` shows `Sign in to continue` to a signed-out window.
- `desktop-handoff` sends the AuthKit link to `xdg-open` and shows `Finish signing in` with the link.
- `desktop-open-browser` sends the same link again from the dialog's `Open browser`.
- `desktop-cancel` closes the dialog and returns to the gate.
- `desktop-complete` signs the window in after the AuthKit redirect reaches `http://127.0.0.1:7731/api/auth/desktop-login/callback`.
- `desktop-persist` keeps the window signed in across a relaunch.

## How to get to it (user POV)

- Open the desktop app while signed out and choose `Sign In` or `Create Account`.
- Finish signing in at AuthKit in the browser that opens.

## Driving it with agent-browser

Preconditions:

- Open the app as in `SKILL.md`, showing `heading "Sign in to continue"`.
- The host of `~/.sprocket-dev-verify` is signed in. If not, `$V/login.sh` needs the user, as in [`verify-sprocket`'s sign-in](../../verify-sprocket/features/sign-in.md).

- **Gate.** `snapshot -i` shows `button "Sign In"` and `button "Create Account"`. Screenshot it.
- **Hand-off.** Note `wc -l < /tmp/verify-sprocket-desktop/opened-urls.log`, then `agent-browser click $($V/ref.sh 'button "Sign In"')` and `agent-browser wait --text "Finish signing in"`. Plain `snapshot` shows `dialog "Finish signing in"` with "We opened your browser to complete sign-in.", the link as text, `button "Open browser"`, `button "Copy link"` and `button "Cancel"`. The log gains one line with `https://api.workos.com/user_management/authorize?client_id=client_01KXV3JY0XR7PB38TNN8TKP2D1&redirect_uri=http%3A%2F%2F127.0.0.1%3A7731%2Fapi%2Fauth%2Fdesktop-login%2Fcallback&...`. That client is the dev deployment's WorkOS client. The text in the dialog and the log line match.
- **Open browser.** Click `button "Open browser"`. The log gains a second line with the same URL, through the window-open handler this time.
- **Cancel.** Click `button "Cancel"`. The gate returns with `button "Sign In"`.
- **Complete.** Needs the user, see Gotchas. After it, the window shows `button "New thread"` without a reload.
- **Persist.** Run Cleanup step 2, launch again and `$D/connect.sh`. `button "New thread"` with no gate is the proof.
- **Proof.** Screenshots of the gate, the dialog and the gate after cancel, plus the new `opened-urls.log` lines.

## Gotchas

- `desktop-complete` needs an AuthKit sign-in in a real browser, which the agent cannot do. The user-assisted route, not yet run: send the user the logged URL, they sign in on their device, their browser fails to load the `127.0.0.1:7731` callback, and they send back that address. `curl` it from this box, since the callback accepts only loopback peers. Report it unreachable otherwise.
- `Create Account` takes the same path with the sign-up flow.
- Gate, hand-off, open browser and cancel have been run. Complete and persist have not.
- A `client_id` other than the dev one means the server read another deployment's `WORKOS_CLIENT_ID`. Stop and run Cleanup.
- With no recorder on `PATH`, `xdg-open` is missing on this box, and the dialog switches to `Open the sign-in link` with the error `spawn xdg-open ENOENT`.
