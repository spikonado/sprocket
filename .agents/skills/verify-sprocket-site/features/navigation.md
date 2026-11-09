# Navigation

Every page shares one navbar and one footer. Desktop shows inline links; below 768 px a `Menu` button opens a popover with the same links.

## Sub-features

- `nav-desktop` links `Home`, `Pricing`, `GitHub` and `Download`.
- `nav-mobile` opens the `Mobile` navigation popover, and closes it when a link is chosen.
- `nav-footer` links the site, Spikonado pages and five socials.
- `nav-skip` jumps to `#main` from the keyboard.

## How to get to it (user POV)

- The bar at the top of `/` and `/pricing`.
- The `Menu` button at a phone width.
- The footer at the bottom of either page.

## Driving it with agent-browser

Preconditions:

- Baseline from [README.md](./README.md).

- **Desktop links.** At `set viewport 1440 900`, `snapshot -i -u` lists `navigation "Primary"` with `Home` to `/` and `Pricing` to `/pricing`, `GitHub` to `https://github.com/spikonado/sprocket`, and `Download` to `/#download`.
- **Navigate.** Run `agent-browser click $($R 'link "Pricing"')` and `agent-browser wait --url "**/pricing"`. The `Pricing` heading shows. Choose `Download` there and the browser lands on `/#download` with `Start building with Sprocket` in view.
- **Mobile menu.** Run `agent-browser set device "iPhone 14"`, reopen `/`, hide the toolbar, then `agent-browser click $($R 'button "Menu" [expanded')`. The snapshot shows `button "Menu" [expanded=true]` and `navigation "Mobile"` with `Home`, `Pricing`, `GitHub` and `Download`. `agent-browser eval "document.getElementById('mobile-nav').matches(':popover-open')"` prints `true`.
- **Menu closes on a link.** Choose `Download` in `navigation "Mobile"`. The popover check prints `false` and the page scrolls to `#download`.
- **Footer.** `snapshot -i -u` lists `Home`, `Pricing`, `Download`, `GitHub`, then `Spikonado` (`https://spikonado.com/`), `Build log` (`/#build-log`), `Privacy Policy` (`/privacy`), and socials `GitHub`, `X`, `YouTube`, `Instagram`, `Facebook`, each to `.../spikonado`.
- **Skip link.** Reload, run `agent-browser press Tab`, then `agent-browser screenshot`. `Skip to content` shows top left; `press Enter` moves the URL to `#main`.
- **Proof.** Screenshot each viewport with the menu open and closed.

## Gotchas

- Astro's dev toolbar has its own `button "Menu"`, so `find role button --name Menu` can hit it. Run `$S/hide-dev-toolbar.sh` and match `'button "Menu" [expanded'`.
- External links open in a new tab. Check their `url=` instead of following them, so the run stays on localhost.
