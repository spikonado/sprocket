---
name: cleanup
description: Use to clean up designs and code.
disable-model-invocation: true
---

## Who runs it

Run the task in a fresh context, on Opus 5.5 when possible:

- If you are Opus 5.5 working in a fresh context, do the task yourself.
- Otherwise, spawn an Opus 5.5 subagent to do it.
- If you can't spawn Opus 5.5, do the task yourself when your context is fresh. When it isn't, spawn a subagent on another model.

Give the subagent only the paths or PR to clean up and the name of this skill, so it judges the work without your reasoning.

## Task

Go through the requested designs and code and fix every place that breaks your system instructions' "Code and design quality" and "Writing style" sections. When cleaning up a PR, work from its full diff against the base branch. Remove compatibility added only for earlier revisions of the PR when no supported consumer or existing data needs it.
