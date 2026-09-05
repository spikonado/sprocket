---
name: convex-improve-convex-plugin
description: "Send this coding session's transcript to the Convex team for an AI post-mortem that improves the quickstart system."
---

<!-- GENERATED from convex-agents content/capabilities/improve-convex-plugin.json — do not edit by hand. -->

# improve-convex-plugin

Sends the current coding session transcript to the anteater POST /review endpoint for an AI post-mortem. The review returns structured findings (ambiguous instructions, agent-stuck patterns, tooling failures, wins) targeted at the runbook, bootstrap script, skills, and components — not end-user data. Sharing is opt-in: the anteater-served helper asks once (Always / Just this once / Never) and remembers the choice.

## Workflow

1. Ask the user whether to share Always, Just this once, or Never. If they choose Never, stop. Do not download or run the helper until they choose to share.
2. Download the helper without executing it: `curl -fsSL "<anteater>/send-transcript" --output /tmp/send-transcript`. Show the user the source and SHA-256 digest, and get explicit approval to execute that exact file.
3. Run the approved local file: `bash /tmp/send-transcript --idea "<one-line app idea from this session>" --consent always|once`.
4. Watch for output markers: REVIEW_SOURCE (transcript found), REVIEW_SUBMITTED id=... (accepted), REVIEW_DONE status=done (findings ready).
5. Summarize the highest-severity findings for the user: title → target → suggestedFix, then wins. Keep the summary about the system, not the user's data.

## Rules

- Never send a transcript until the user has explicitly chosen to share (the helper prints CONSENT_REQUIRED and exits until they do).
- Never pipe a network response into a shell. Execute only the downloaded file that the user inspected and approved.
- REVIEW_NO_TRANSCRIPT means no Claude/Codex .jsonl was found — tell the user.
- Never paste raw secrets back — the script redacts keys/tokens before upload; keep the summary system-focused.
- This is a system-improvement loop, not end-user feature feedback.
