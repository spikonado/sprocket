# Third-party notices

## Managed browser tools

Sprocket downloads unmodified native releases of
[agent-browser](https://github.com/vercel-labs/agent-browser) on demand. It is
copyright Vercel, Inc., and licensed under
[Apache-2.0](https://github.com/vercel-labs/agent-browser/blob/main/LICENSE).
When serving agent-browser's dashboard, Sprocket changes its web assets to
offer only Chrome and hide AI chat, as listed in
`tools/agent-browser/dashboard-patches.json`.

Versions, release asset sizes, and SHA256 checksums are recorded in
`tools/agent-browser/releases.json`. Chromium downloaded by the
upstream installer retains its own third-party licenses and notices.

## Bun

Sprocket downloads unmodified releases of [Bun](https://github.com/oven-sh/bun)
on demand. Bun is licensed under
[MIT](https://github.com/oven-sh/bun/blob/main/LICENSE.md) and statically links
libraries under their own licenses, including JavaScriptCore under LGPL-2.

The Bun version, archive sizes, and SHA256 checksums are recorded in
`tools/bun/releases.json`.

## agent-desktop

Sprocket downloads unmodified native releases of
[agent-desktop](https://github.com/vercel-labs/agent-desktop) on demand. It is
copyright Vercel, Inc., and licensed under
[Apache-2.0](https://github.com/vercel-labs/agent-desktop/blob/main/LICENSE).

The agent-desktop version, archive sizes, and SHA256 checksums are recorded in
`tools/agent-desktop/releases.json`.
