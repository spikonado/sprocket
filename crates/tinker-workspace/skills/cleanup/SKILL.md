---
name: cleanup
description: Use to clean up designs and code.
disable-model-invocation: true
---

### If you are Opus 5.5

If you are working in a fresh context, do the task given below. If not, spawn an Opus 5.5 subagent to do it. Only give it references to the designs/code and this skill.

### If you are some other model

If available, spawn an Opus 5.5 subagent. If not available and you are working in a fresh context, do the task below. If neither condition applies, spawn a subagent using a different model.

### Task

Go through the requested designs/code and implement cleanup opportunities. Look for over-engineering, unnecessary text, unnecessary abstractions, duplication, and tests that don't add useful coverage. When cleaning up a PR, inspect the full PR diff, not individual commits. Remove compatibility added only for earlier revisions of the PR when no supported consumer or existing data needs it.
