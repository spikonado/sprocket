# Sprocket

**Goal**: To make the world's best platform for developing hardware and software.

Here's what makes Sprocket special:

- The only AI agent that can work on both <ins>hardware</ins> and <ins>software</ins>.
- Retrieves best-in-class <ins>context from the web</ins> for everything it does, so it stays <ins>incredibly reliable</ins>.
- <ins>Buys anything from any website</ins> when you ask, from hardware parts to SaaS subscriptions.
- Makes <ins>beautifully detailed schematics</ins>, creates your <ins>BOM</ins>, and writes <ins>assembly instructions</ins>.

[Sprocket Demo](https://www.youtube.com/watch?v=E8KWO3Vh9YU)

[![Sprocket](./assets/sprocket.png)](https://www.youtube.com/watch?v=E8KWO3Vh9YU)

## Using Sprocket

### Desktop app

Download the installer for your OS from the [latest release](https://github.com/spikonado/sprocket/releases/latest), install it, and open Sprocket. Sign in, choose a project folder, and ask Sprocket what you'd like to build.

### Run without installing

With [Node.js](https://nodejs.org/) 20.11 or newer installed:

```sh
npx @spikonado/sprocket
```

This opens Sprocket in your browser, or in the desktop app if it's installed. Sign in and choose a project folder to get started. Add `--web` to always use your browser.

### CLI

```sh
npm install -g @spikonado/sprocket
sprocket
```

Open a project folder in the app, or force it to open in your browser:

```sh
sprocket .
sprocket --web ../my-robot
```

To run a task directly from your terminal, run these commands in your project folder:

```sh
sprocket login
sprocket run "Fix the failing tests"
```

Update your CLI installation with `sprocket update`. Run `sprocket --help` for more options.

### Agent browser

Agents use the ordinary `agent-browser` CLI through shell commands. The built-in
skill loads usage instructions from the installed CLI. Open **Browser** in the
side panel to watch and interact with the upstream dashboard; agents and humans
can interact concurrently, and agents manage their own named sessions.

Sprocket prepares a pinned CLI in its data directory in the background. It reuses
an existing Chrome, Chromium, Brave, Edge, or cached browser executable before
running the upstream unprivileged Chrome installer. It does not import your
personal browser profile. Set `AGENT_BROWSER_EXECUTABLE_PATH` to an absolute
Chromium-family executable path to select one explicitly. Setup errors and retry
are available in the Browser panel; other agent work does not wait for downloads.
Linux ARM64 currently requires an existing Chromium installation. Missing system
libraries must be installed by you; Sprocket never runs sudo.

Choosing Lightpanda in the dashboard installs its pinned binary on supported
Linux/macOS hosts. Lightpanda is nonvisual: it has no live Chrome viewport.
For CLI use, pass its absolute path with `--engine lightpanda --executable-path`.
Browser sessions, profiles, and idle cleanup remain upstream responsibilities;
there is no cloud cookie synchronization or Sprocket session ownership layer.

## Troubleshooting

- If `17731` is already occupied, set `SPROCKET_PORT` before launching.
- If sign-in cannot save or restore your session, check that your operating system credential service is available, or use `sprocket login --credential-store file`.
- If `sprocket` opens the browser instead of the desktop app, install `sprocket-desktop` from [GitHub Releases](https://github.com/spikonado/sprocket/releases) onto `PATH`, or set `SPROCKET_DESKTOP_EXECUTABLE`.
- Unsigned macOS and Windows desktop builds may need a Gatekeeper / SmartScreen override the first time you open them.
- Contact [aarav@spikonado.com](mailto:aarav@spikonado.com) for help.

## License

Sprocket is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md). Third-party material remains under the licenses listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
