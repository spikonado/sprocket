# Tinker

The best AI agent for hardware and software.

Tinker designs electronics, tests code end-to-end, and buys parts or subscriptions for your project when asked.

[![Tinker](./assets/sprocket.webp)](https://spikonado.com/sprocket)

## Using Tinker

### Desktop app

Download the installer for your OS from the [latest release](https://github.com/spikonado/sprocket/releases/latest), install it, and open Tinker. Sign in, choose a project folder, and ask Tinker what you'd like to build.

### Run without installing

With [Node.js](https://nodejs.org/) 20.11 or newer installed:

```sh
npx usetinker
```

This opens Tinker in your browser, or in the desktop app if it's installed. Sign in and choose a project folder to get started. Add `--web` to always use your browser.

### CLI

```sh
npm install -g usetinker
tinker
```

Open a project folder in the app, or force it to open in your browser:

```sh
tinker .
tinker --web ../my-robot
```

To run a task directly from your terminal, run these commands in your project folder:

```sh
tinker login
tinker run "Fix the failing tests"
```

Update your CLI installation with `tinker update`. Run `tinker --help` for more options.

## Troubleshooting

- If `17731` is already occupied, set `TINKER_PORT` before launching.
- Tinker uses your operating system credential service when available, and automatically falls back to an unencrypted private file when it is unavailable. Use `tinker login --credential-store keyring` to require keyring storage, or `tinker login --credential-store file` to require file storage.
- If `tinker` opens the browser instead of the desktop app, install `tinker-desktop` from [GitHub Releases](https://github.com/spikonado/sprocket/releases) onto `PATH`, or set `TINKER_DESKTOP_EXECUTABLE`.
- Unsigned macOS and Windows desktop builds may need a Gatekeeper / SmartScreen override the first time you open them.
- Contact [aarav@spikonado.com](mailto:aarav@spikonado.com) for help.

## License

Tinker is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md). Third-party material remains under the licenses listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
