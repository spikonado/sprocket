# Home

The home page at `/` pitches Sprocket, links the latest desktop release for the visitor's OS, copies the `npx usesprocket` command, and opens the product screenshot full size.

## Sub-features

- `home-hero` shows the heading `The best AI agent for hardware and software.` and the release badge.
- `home-download` links the installer for the detected OS, with the other platforms below it.
- `home-copy` copies `npx usesprocket` and flips the button to `Copied`.
- `home-screenshot` opens and closes the full-size screenshot dialog.
- `home-sections` renders the five showcases, the capabilities grid, and `#download`.

## How to get to it (user POV)

- Open `/`, or choose `Home` or the `Sprocket` logo in the navbar or footer.
- Reach `#download` from the navbar's `Download` button or the footer's `Download` link.

## Driving it with agent-browser

Preconditions:

- Baseline from [README.md](./README.md), at `set viewport 1440 900`.

- **Hero.** Run `agent-browser snapshot -i -u`. It lists `heading "The best AI agent for hardware and software."` and `link "New Sprocket vX.Y.Z is out"` with a `url=https://github.com/spikonado/sprocket/releases/tag/vX.Y.Z`.
- **Download, desktop.** Wait for hydration with `agent-browser wait --text "Download for Linux"`, since the headless browser reports Linux. Its `url=` is the Linux asset of the release in the badge. Check the href; clicking downloads a large installer.
- **Download, mobile.** Run `agent-browser set device "iPhone 14"`, reopen `/`, and run `$S/hide-dev-toolbar.sh`. The button reads `Download desktop app` and points at `releases/latest`, with links `Apple Silicon`, `Intel Mac`, `Windows`, `Linux x64` and `Linux ARM` below it.
- **Copy command.** Run `agent-browser click $($R 'button "Copy command"')`. The next `snapshot -i` shows `button "Copied"`, which turns back after about 2 seconds.
- **Screenshot dialog.** Run `agent-browser click $($R 'button "View Sprocket screenshot full size"')`. Plain `snapshot` shows `dialog "Sprocket screenshot"`. Run `agent-browser click $($R 'button "Close full size image"')`, and the dialog leaves the snapshot.
- **Sections.** Run `agent-browser screenshot --full $OUT/NN-home.png`. The snapshot has regions `Designs electronics`, `Works from real docs`, `Buys what the project needs`, `Asks before guessing`, `Splits big tasks`, `Everything you need to invent`, and `Start building with Sprocket`, the last with a `See pricing →` link to `/pricing`.

## Gotchas

- The release comes from `api.github.com` on each request. When that call fails or is rate limited, the badge disappears and the download button falls back to `releases/latest`. Check the server log before calling that a regression.
- The download button reads `Download desktop app` until the island hydrates, then switches to the detected OS. Wait for the OS label before reading its href.
- `navigator.clipboard.readText()` is denied in this headless browser, so `Copied` is the proof. The button only flips after `writeText` resolves.
- The screenshot image loads lazily, so a full-page screenshot taken right after `open` can show its frame empty. Scroll to it or wait a second first.
