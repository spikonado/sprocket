# Navigation

Every page shares one navbar and one footer. Desktop shows inline links, and at a phone width a `Menu` button opens a popover with the same links.

## Sub-features

- `nav-desktop` shows the page links from `apps/site/src/components/navbar.astro`, then `GitHub` and `Download`.
- `nav-mobile` opens the `Mobile` navigation popover, and closes it when a link is chosen.
- `nav-footer` links the site, Spikonado pages and socials.
- `nav-skip` jumps to `#main` from the keyboard.

## How to get to it (user POV)

- The bar at the top of `/` and `/pricing`.
- The `Menu` button at a phone width.
- The footer at the bottom of either page.

## Driving it with agent-browser

Preconditions:

- Baseline from [README.md](./README.md).

- **Desktop links.** At `set viewport 1440 900`, `snapshot -i -u` lists `navigation "Primary"` with each link from `navbar.astro` at its `href`, `GitHub` to `https://github.com/spikonado/sprocket`, and `Download` to `/#download`.
- **Navigate.** Run `agent-browser click $($R 'link "Pricing"')` and `agent-browser wait --url "**/pricing"`. The `Pricing` heading shows. Choose `Download` there and the browser lands on `/#download` with `Start building with Sprocket` in view.
- **Mobile menu.** Run `agent-browser set device "iPhone 14"`, reopen `/`, hide the toolbar, then `agent-browser click $($R 'button "Menu" [expanded')`. The snapshot shows `button "Menu" [expanded=true]` and `navigation "Mobile"` with the desktop links. `agent-browser eval "document.getElementById('mobile-nav').matches(':popover-open')"` prints `true`.
- **Menu closes on a link.** Choose `Download` in `navigation "Mobile"`. The popover check prints `false` and the page scrolls to `#download`.
- **Footer.** `snapshot -i -u` lists the links from `apps/site/src/components/footer.astro` and the socials from `ORGANIZATION_SOCIALS` in `apps/site/src/lib/seo.ts`, each at its `href`.
- **Skip link.** Reload, run `agent-browser press Tab`, then `agent-browser screenshot`. `Skip to content` shows top left; `press Enter` moves the URL to `#main`.
- **Proof.** Screenshot each viewport with the menu open and closed.

## Gotchas

- Astro's dev toolbar has its own `button "Menu"`, so `find role button --name Menu` can hit it. Run `$S/hide-dev-toolbar.sh` and match `'button "Menu" [expanded'`.
- External links open in a new tab. Check their `url=` instead of following them, so the run stays on localhost.
- `Docs` goes to `/docs`, a Vercel rewrite that 404s in dev. Check its `url=` instead of following it.
