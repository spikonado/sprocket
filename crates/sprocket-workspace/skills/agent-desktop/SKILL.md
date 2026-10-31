---
name: agent-desktop
description: Desktop app automation CLI. Use to see and operate native apps on this machine through the OS accessibility tree, including windows, menus, dialogs, notifications, and the clipboard. Use agent-browser for web pages.
---

# agent-desktop

`agent-desktop` is on your `PATH`. Its guides ship inside the binary and match its version. Load both before your first command and follow them:

```bash
agent-desktop skills get desktop    # the snapshot, act, verify loop and the retry rules
agent-desktop skills get platform   # permissions and limits on this OS
```

The desktop is the user's own, and they may be using it while you work. Stay headless unless the user allows `--headed`, which moves their pointer and takes focus.

When `agent-desktop status` reports a missing permission or no accessibility bus, tell the user what the platform guide asks them to grant or install instead of working around it.
