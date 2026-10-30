# Third-party notices

## Managed browser tools

Sprocket downloads unmodified native releases of
[agent-browser](https://github.com/vercel-labs/agent-browser) on demand. It is
copyright Vercel, Inc., and licensed under
[Apache-2.0](https://github.com/vercel-labs/agent-browser/blob/v0.39.3/LICENSE).
When serving agent-browser's dashboard, Sprocket changes its web assets to
offer only Chrome and hide AI chat, as listed in
`tools/agent-browser/dashboard-patches.json`.

Versions, release asset sizes, and SHA256 checksums are recorded in
`tools/agent-browser/releases.json`. Chromium downloaded by the
upstream installer retains its own third-party licenses and notices.
