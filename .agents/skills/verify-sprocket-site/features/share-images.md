# Share images

The server renders the link-preview image `/og.png` with Satori and the iOS home screen icon `/apple-touch-icon.png` with sharp. Every page's head points at them.

## Sub-features

- `og-image` is a 1200x630 PNG with the Sprocket lockup, the headline, and `usesprocket.dev`.
- `touch-icon` is a 180x180 PNG of the logo on `#f0f4eb`, with no transparency.
- `share-meta` sets `og:image`, `twitter:image`, their size and alt tags, `apple-touch-icon` and the SVG favicon.

## How to get to it (user POV)

- A chat app or social site fetches `og:image` when someone shares a link.
- iOS fetches `apple-touch-icon` when a visitor adds the site to the home screen.

## Driving it with agent-browser

Preconditions:

- Baseline from [README.md](./README.md).

- **Fetch.** Run `curl -s -D $OUT/og.headers -o $OUT/og.png http://localhost:4335/og.png` and the same for `apple-touch-icon.png`. Each header file has `HTTP/1.1 200 OK` and `content-type: image/png`.
- **Size.** Run `python3 -c 'import struct,sys; [print(f, struct.unpack(">II", open(f,"rb").read(24)[16:24])) for f in sys.argv[1:]]' $OUT/og.png $OUT/apple-touch-icon.png`. It prints `(1200, 630)` and `(180, 180)`.
- **Look.** Open both with `parse_file`. The OG image shows the Sprocket lockup top left, `The best AI agent for` and a highlighted `hardware and software`, the subtitle, `usesprocket.dev` bottom left and `Build more tech, faster.` bottom right. The icon shows the blue tornado logo centered on a pale green square.
- **Meta.** Run `curl -s http://localhost:4335/ | grep -oE '<meta (property|name)="(og|twitter):image[^>]*>|<link rel="(icon|apple-touch-icon)"[^>]*>'` and the same for `/pricing`. It lists `og:image` and `twitter:image` at `https://usesprocket.dev/og.png`, width `1200`, height `630`, type `image/png`, and `apple-touch-icon` at `/apple-touch-icon.png`.
- **Browser.** In the agent-browser session, `agent-browser open http://localhost:4335/og.png` and `agent-browser screenshot $OUT/NN-og-in-browser.png` show the same image served to a browser.

## Gotchas

- The meta tags always name `https://usesprocket.dev/og.png`, the prod copy. Fetch `localhost:4335/og.png` to see this worktree's image.
- Both routes read files relative to `apps/site`, the server's working directory, including the Geist fonts from `apps/site/node_modules`. A 500 here after a dependency change usually means `bun install` did not run.
