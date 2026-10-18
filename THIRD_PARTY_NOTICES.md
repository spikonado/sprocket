# Third-party notices

## Managed browser tools

Sprocket downloads unmodified native releases of
[agent-browser](https://github.com/vercel-labs/agent-browser) on demand. It is
copyright Vercel, Inc., and licensed under
[Apache-2.0](https://github.com/vercel-labs/agent-browser/blob/v0.38.2/LICENSE).
When serving agent-browser's dashboard, Sprocket changes its web assets to
hide cloud browser providers and AI chat, as listed in
`tools/agent-browser/dashboard-patches.json`.

When a dashboard session uses Lightpanda, Sprocket downloads an unmodified
native release of [Lightpanda Browser](https://github.com/lightpanda-io/browser).
It is copyright Lightpanda, and licensed under
[AGPL-3.0](https://github.com/lightpanda-io/browser/blob/1.0.1/LICENSE).

Versions, release asset sizes, and SHA256 checksums are recorded in
`tools/agent-browser/releases.json`. Chromium downloaded by the
upstream installer retains its own third-party licenses and notices.
