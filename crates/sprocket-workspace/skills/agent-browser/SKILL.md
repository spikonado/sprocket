---
name: agent-browser
description: Use agent-browser for website interaction, Electron app automation, and exploratory testing.
---

# agent-browser

Load the installed CLI's usage guide before browser work:

```bash
agent-browser skills get core
```

For specialized workflows, discover the matching guide with `agent-browser skills list`, then load it with `agent-browser skills get <name>`. Use `agent-browser skills get core --full` when you need the complete reference.

## Sessions across exec calls

Choose a unique named browser session for your task and keep its name in your context. Pass the same explicit `--session` on every browser command across exec calls:

```bash
agent-browser --session <session> open <url>
agent-browser --session <session> snapshot -i
```

Each exec call starts a new shell; a shell `export AGENT_BROWSER_SESSION=...` only applies within that call. Explicit `--session` keeps your browser state together and isolates it from other agents and the user's browser sessions, even when the CLI guide's examples omit the flag.

When finished, close your session:

```bash
agent-browser --session <session> close
```

Sprocket prepares browser tools in the background. If the CLI or browser is not
ready yet, open the Browser panel to see setup progress or retry a failed setup.
Use Chromium for visual interaction. Lightpanda has no live viewport; for that
engine, pass its absolute executable path with `--engine lightpanda --executable-path`.
