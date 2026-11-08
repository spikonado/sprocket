# Login

`sprocket login` signs the local profile's host in with a device code the user approves in any browser. `sprocket logout` signs the profile out for both the app and the CLI. The profile here is the shared `~/.sprocket-dev-verify`, so its sign-in serves every verify skill.

## Sub-features

- `login-check` prints the signed-in account and exits 0 without a new code.
- `login-device` prints a verification URI and code, then waits for approval.
- `login-store` forces a new login into `--credential-store keyring` or `file`.
- `logout` signs the profile out.

## How to get to it (user POV)

- `sprocket login`, then approve the printed code in a browser.
- `sprocket login --credential-store file`.
- `sprocket logout`.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold, and the `serve` session from Launch is running.
- For `login-device`, `login-store` and `logout`: the user has said they are at their keyboard. Codes expire after about 5 minutes. The agent never approves a code itself.

- **Signed-in check.** `$C/record.sh $OUT/01-login $C/cli.sh login`. Exit 0, stderr `Signed in as <email>`, and no code.
- **Device login.** On a signed-out profile, start `$C/cli.sh login` as a background session. Stderr prints `Open https://reassuring-poem-42-sprocket-previews.authkit.app/device in a browser and approve code XXXX-XXXX`. Send the user that URI and code. After approval it prints `Signed in as <email>` and exits 0. Then rerun Signed-in check as the second view.
- **Credential store.** `$C/cli.sh login --credential-store file` always starts a device login, even when signed in. After approval stderr also prints a notice that file storage is not encrypted. The second view is `ls ~/.sprocket-dev-verify/credentials/`.
- **Logout.** `$C/record.sh $OUT/02-logout $C/cli.sh logout`. Exit 0, stderr `Signed out of this local Sprocket profile.` The second view is `$C/cli.sh run --list-models` failing with `not signed in; run sprocket login`. Then do Device login, since every verify skill needs the sign-in back.

## Gotchas

- `login-device`, `login-store` and `logout` are unreachable without the user. Report them that way instead of waiting on a code.
- The prod AuthKit domain `crisp-glass-80.authkit.app` in the printed URI means the prod `PUBLIC_CONVEX_URL` leaked in. Interrupt the login before sending the code.
- `device login expired` means the user didn't approve in time. Ask again and rerun.
- `../verify-sprocket/scripts/login.sh` needs the web skill's API and runs the shared `debug/sprocket`, which another worktree's build may have relinked. For CLI proof, use `cli.sh login`.
