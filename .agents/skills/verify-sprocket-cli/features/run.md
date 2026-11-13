# Run

`sprocket run` sends a prompt to an agent working in a local directory and waits for its answer. The directory becomes a project in the signed-in account, and the thread shows in the app like any other.

## Sub-features

- `run-new` creates a thread for the current directory and prints its answer.
- `run-followup` continues a thread with `--thread <id>`.
- `run-prompt-file` reads the prompt from `--prompt-file <path>` or `--prompt-file -` (stdin).
- `run-directory` works in `-C <dir>` instead of the current directory.
- `run-settings` applies `--model`, `--reasoning`, `--fast` and `--no-fast`.
- `run-list-models` lists models and reasoning efforts with `--list-models`.
- `run-timeout` cancels after `--timeout` and exits 124.
- `run-interrupt` cancels on Ctrl+C, SIGTERM or SIGHUP and exits 130, 143 or 129.
- `run-errors` rejects an empty prompt, a missing sign-in and app launch arguments.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold, and the `serve` session from Launch is running.
- Doctor reports `host signed in`.

- **List models.** `$C/record.sh $OUT/01-models $C/cli.sh run --list-models`. Exit 0. Stdout lists each model with its reasoning efforts and marks the defaults.
- **New thread.** `$C/record.sh $OUT/02-run $C/cli.sh run "Reply with exactly: pong"`. Exit 0. The stderr header names the thread and run ids, then the model, reasoning and Fast setting. Stdout is `pong`.
- **Attached project.** `grep -F "$SCRATCH" ~/.sprocket-dev-verify/project-attachments.json > $OUT/02-attachment.txt`. The scratch path is there.
- **Follow-up.** Take the thread id from `02-run.err`, then `$C/record.sh $OUT/03-followup $C/cli.sh run --thread <thread-id> "What word did you reply with before? One word."`. Exit 0, the same thread id with a new run id, and stdout `pong`. This recall is the second view of the first run.
- **Prompt from stdin.** `echo "Reply with exactly: stdin" | $C/record.sh $OUT/04-stdin $C/cli.sh run --prompt-file -`. Exit 0, stdout `stdin`.
- **Other directory.** From `/tmp`, `$C/record.sh $OUT/05-dir $C/cli.sh run -C $SCRATCH --no-fast "Reply with exactly: dir"`. Exit 0, Fast off in the header, stdout `dir`.
- **Settings.** Pick a non-default id and effort from `01-models.out`, then run with `--model <id> --reasoning <effort>`. The header names both.
- **Timeout.** `$C/record.sh $OUT/06-timeout $C/cli.sh run --timeout 1s "Count slowly from 1 to 50, one number per line."`. Exit 124, the header on stderr and no answer on stdout.
- **Interrupt.** Start `$C/cli.sh run "Count slowly from 1 to 50, one number per line."` as a background session, wait for its header, then send `\u0003` with `control_cmd write`. Exit 130.
- **Errors.** Each fails before any server or model call:
  - `$C/cli.sh run "   "` exits 1 with the empty prompt error.
  - `$C/cli.sh --web run "x"` and `$C/cli.sh . run "x"` exit 1 and point to `run --directory`.
  - `$C/cli.sh run -C /tmp/does-not-exist "x"` exits 1 because the workspace does not exist.
  - `$C/cli.sh run` with no prompt prints the `run` help and exits 2, as does `run --web "x"` with an unexpected argument error.

## Gotchas

- Run Timeout and Interrupt only when the change touches cancellation.
- `--model` and `--reasoning` are saved on the thread, so later follow-ups without them keep the override. A follow-up after a failed model choice fails the same way until you pass a working `--model`.
- Some listed models fail on dev because their provider has no API key there. If Settings fails that way, pick an `opus-*` or `gpt-*` model.
- `--thread` from another directory fails because the thread belongs to a different repository. Run follow-ups from the same project.
- A signed-out host fails with `not signed in`. That is a precondition failure, not a pass of `run-errors`.
- A failed reply with `Subscription tiers are unavailable.` means the dev `tiers` table is empty. Report it to the user.
- After Interrupt, stderr may say the final state could not be confirmed. The CLI gives up waiting for the cancellation after 15 s and still exits 130.
