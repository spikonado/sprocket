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

## uv and Python

Sprocket downloads unmodified releases of [uv](https://github.com/astral-sh/uv)
on demand. uv is licensed under
[MIT](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT) or
[Apache-2.0](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE). The uv
version, archive sizes, and SHA256 checksums are recorded in
`tools/uv/releases.json`.

uv then installs a [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
build of CPython, which is licensed under the
[PSF License](https://docs.python.org/3/license.html) and bundles libraries
under their own licenses.

## KiCad

The KiCad connector downloads [KiCad](https://www.kicad.org) nightly builds
when the user installs it. KiCad is licensed under
[GPL-3.0-or-later](https://gitlab.com/kicad/code/kicad/-/blob/master/LICENSE.GPLv3),
and its bundled symbol, footprint, and 3D model libraries are licensed under
[CC-BY-SA-4.0 with an exception](https://www.kicad.org/libraries/license/) for
designs made with them. The builds are unmodified upstream files mirrored to a
`kicad-<version>` release of this repository, whose notes link the exact KiCad
source commit.

The same release holds a wheel of
[kicad-python](https://gitlab.com/kicad/code/kicad-python), licensed under
[MIT](https://gitlab.com/kicad/code/kicad-python/-/blob/main/LICENSE), built
with `tools/kicad/kipy-cli-env.patch`. Its Python dependencies keep their own
licenses. The KiCad version, file sizes, and SHA256 checksums are recorded in
`tools/kicad/releases.json`, and the dependencies' hashes in
`tools/kicad/requirements.txt`.

## KiCanvas

The web app ships a build of [KiCanvas](https://github.com/theacodes/kicanvas)
in `apps/web/static/kicanvas/`, made by `tools/kicanvas/build.sh` from the
commit it pins, with the patches next to that script. KiCanvas is copyright
Alethea Katherine Flowers and licensed under MIT; its license is next to the
build. When it opens a file, it loads its icon and text fonts from Google Fonts.
