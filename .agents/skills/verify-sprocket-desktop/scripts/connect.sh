#!/usr/bin/env bash
# Attaches the current agent-browser session to Electron and selects the app page instead of the detached DevTools.
source "$(dirname "$0")/common.sh"

agent-browser connect "$cdp_port" >/dev/null
target=$(agent-browser tab list --json | python3 -c '
import json, sys
data = json.load(sys.stdin)
tabs = data.get("data", data).get("tabs", [])
print(next(t["targetId"] for t in tabs if t.get("url", "").startswith("http://localhost:5173/")))
')
agent-browser tab "$target" >/dev/null
agent-browser get url
