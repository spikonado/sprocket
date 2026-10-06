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

## Self-hosting

Run the Sprocket app and agent on your own machine and access them through a browser. This still uses Sprocket's hosted sign-in and cloud services; it is not a fully offline setup.

With Node.js 20.11 or newer, install the CLI and start the server:

```sh
npm install -g @spikonado/sprocket
sprocket serve
```

Leave the server running. In another terminal on the same host, sign in by following the printed instructions:

```sh
sprocket login
```

On a headless machine without an OS credential service, use `sprocket login --credential-store file` instead. This stores your sign-in token unencrypted in a private file.

Open `http://127.0.0.1:17731` on that machine. Keep `sprocket serve` running while you use the app; press Ctrl+C to stop it.

### Access from another device

Keep the server on its default local-only address. With [Tailscale](https://tailscale.com/) installed and signed in on both devices, run this in another terminal on the host:

```sh
tailscale serve --bg http://127.0.0.1:17731
```

Open the HTTPS URL printed by Tailscale on your other device and sign in with the same Sprocket account you used on the host. Project folders and agent tasks stay on the host machine.

Remote access requires HTTPS. If you use another reverse proxy, it must connect to `127.0.0.1:17731` and preserve the browser-facing `Host` header.

## Troubleshooting

- If `17731` is already occupied, set `SPROCKET_PORT` before launching.
- If sign-in cannot save or restore your session, check that your operating system credential service is available, or use `sprocket login --credential-store file` as described above.
- If `sprocket` opens the browser instead of the desktop app, install `sprocket-desktop` from [GitHub Releases](https://github.com/spikonado/sprocket/releases) onto `PATH`, or set `SPROCKET_DESKTOP_EXECUTABLE`.
- Unsigned macOS and Windows desktop builds may need a Gatekeeper / SmartScreen override the first time you open them.
- Contact [aarav@spikonado.com](mailto:aarav@spikonado.com) for help.

## License

Sprocket is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md). Third-party material remains under the licenses listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
