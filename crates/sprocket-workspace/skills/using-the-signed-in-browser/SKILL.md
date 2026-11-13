---
name: using-the-signed-in-browser
description: Use when a website needs the user signed in, or shows a captcha or bot check.
---

# Using the signed-in browser

The signed-in browser is one Chrome with a persistent profile, shared by every agent on this machine. Its sign-ins, cookies, and cleared bot checks survive across threads and restarts, unlike those in your thread's own agent-browser session.

Before driving a site's UI, check whether the site has an official API that you can easily use for the task. Checkouts always go through the site's UI.

## 1. Attach to it

Print the running browser's CDP URL:

```bash
agent-browser --session sprocket-signed-in get cdp-url
```

When it reports `Browser not launched`, start the browser headless. This also prints the URL:

```bash
agent-browser --session sprocket-signed-in --profile "$SPROCKET_BROWSER_PROFILE" batch --bail "tab list" "get cdp-url"
```

When that reports `Daemon failed to start`, another agent started the browser at the same moment, so run the first command again.

Launch flags on the `sprocket-signed-in` session relaunch Chrome and close every agent's tab. Pass them only in this launch command and in step 2's headed one. In PowerShell, use `$env:SPROCKET_BROWSER_PROFILE`, since an empty `--profile` also closes the browser.

Open your own tab in it:

```bash
agent-browser --cdp "<cdp-url>" --pin-tab tab new <url>
```

Later commands need no flags, since your thread's session stays on that tab. When a command fails because the browser is gone, such as with `Connection refused` or `tab_gone`, attach again from the start of this step and reload your page.

Done when: a snapshot of your tab shows the site.

## 2. Get past a sign-in or bot check

Sign in yourself when the user gave you credentials for the site. Whenever anything else blocks you, or you need the user to act in the page, switch the browser to headed, then open your tab again with the URL it prints:

```bash
agent-browser --session sprocket-signed-in --profile "$SPROCKET_BROWSER_PROFILE" --headed batch --bail "tab list" "get cdp-url"
```

When the browser is already headed, this changes nothing. Leave it headed afterwards, since switching back closes every agent's tab again. When Chrome can't start headed because the machine has no display, attach again from step 1 and continue headless.

Many bot checks clear on their own in a headed browser, so wait up to 30 seconds for text from the real page. When the check stays, try your best to solve it yourself without involving the user. For a sign-in, 2FA prompt, or a check you can't solve:

1. Call `ask_question` with a short `yieldTimeMs`, one question per blocked site. Name the site and what blocks it, and say the user can clear it in that site's tab in Sprocket's Browser view, or in the signed-in Chrome window when it's headed. Offer `Done` and `Skip this site`.
2. Keep working on the parts of the task that don't need this tab. When nothing else is left, end your turn.
3. After `Done`, snapshot the tab and continue.

Done when: your tab shows the page behind the check, or the user chose `Skip this site`.

## 3. Finish

Close your tab, then detach. `close` only detaches, so the browser and other agents' tabs keep running.

```bash
agent-browser tab close
agent-browser close
```
