---
name: cleanup
description: Use to clean up code.
---

Go through the requested code and implement cleanup opportunities. Look for over-engineering, unnecessary abstractions, duplication, and tests that don't add useful coverage. When cleaning up a PR, inspect the full PR diff, not individual commits. Remove compatibility added only for earlier revisions of the PR when no supported consumer or existing data needs it.
