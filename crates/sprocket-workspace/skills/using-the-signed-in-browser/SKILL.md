---
name: using-the-signed-in-browser
description: Use when a website needs the user signed in, or shows a captcha or bot check.
---

# Using the signed-in browser

The signed-in browser is one headed Chrome with a persistent profile, shared by every agent on this machine. Its sign-ins, cookies, and cleared bot checks survive across threads and restarts, unlike those in your thread's own agent-browser session.

Before driving a site's UI, check whether the site has an official API that you can easily use for the task. Checkouts always go through the site's UI.

## 1. Attach to it

Start the browser, or reuse the running one, and print its CDP URL:

```bash
agent-browser --session sprocket-signed-in --profile "$SPROCKET_BROWSER_PROFILE" --headed batch --bail "tab list" "get cdp-url"
```

In PowerShell, use `$env:SPROCKET_BROWSER_PROFILE`. Address the `sprocket-signed-in` session only with this exact command. Any other flags relaunch the browser under every agent using it.

Open your own tab in it:

```bash
agent-browser --cdp "<cdp-url>" --pin-tab tab new <url>
```

Later commands need no flags, since your thread's session stays on that tab. When a command fails because the browser is gone, such as with `Connection refused` or `tab_gone`, run both commands again. When the first one reports `Daemon failed to start`, rerun it.

Done when: a snapshot of your tab shows the site.

## 2. Get past a sign-in or bot check

Many bot checks clear on their own in this browser, so wait up to 30 seconds for text from the real page. When the check stays, try your best to solve it yourself without involving the user. If you can't:

1. Call `ask_question` with a short `yieldTimeMs`, one question per blocked site. Name the site and what blocks it, and say the user can clear it in the signed-in Chrome window or in that site's tab in Sprocket's Browser view. Offer `Done` and `Skip this site`.
2. Keep working on the parts of the task that don't need this tab. When nothing else is left, end your turn.
3. After `Done`, snapshot the tab and continue.

Hand off a sign-in or 2FA prompt the same way, unless the user gave you credentials for that site.

Done when: your tab shows the page behind the check, or the user chose `Skip this site`.

## 3. Finish

Close your tab, then detach. `close` only detaches, so the browser and other agents' tabs keep running.

```bash
agent-browser tab close
agent-browser close
```
