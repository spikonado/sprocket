# Pricing

`/pricing` lists plans and credit packs from the live Convex catalog, switches between monthly and yearly prices, and starts sign-in and checkout from each card.

## Sub-features

- `pricing-catalog` renders plan cards from `pricing:getPublicCatalog` in the server HTML.
- `pricing-interval` switches `Monthly` and `Yearly`.
- `pricing-free` sends `Start free` to `/#download`.
- `pricing-packs` lists credit packs with a `Buy for $N` button.
- `pricing-faq` expands each question.
- `pricing-checkout` signs in through `/api/pricing/sign-in`, then starts a Dodo checkout.

## How to get to it (user POV)

- `Pricing` in the navbar, mobile menu or footer, the hero chip (accessible name `Pricing`), or `See pricing →` at the end of `/`.

## Driving it with agent-browser

Preconditions:

- Baseline from [README.md](./README.md).
- The dev catalog has paid plans without prices and one `$5` credit pack. Read it with `curl -s -X POST <dev Convex URL>/api/query -H 'content-type: application/json' -d '{"path":"pricing:getPublicCatalog","args":{},"format":"json"}'`, taking the URL from `doctor.sh`'s output.

- **Open.** Run `agent-browser open http://localhost:4335/pricing`, then `agent-browser wait --text "Sign-in is not configured"` and `$S/hide-dev-toolbar.sh`. The session check has then finished and the buttons are enabled.
- **Catalog.** Plain `snapshot` shows `heading "Free"` with `$0`, then a heading per paid plan in the catalog, each reading `Unavailable` with a disabled `Unavailable` button, then `region "Credit packs"` with `$5 of AI usage` and `button "Buy for $5"`. `curl -s http://localhost:4335/pricing | grep -o 'Everything in' | wc -l` prints the number of paid plans, which shows the server rendered the catalog too.
- **Interval.** Run `agent-browser click $($R 'radio "Yearly"')`, then `agent-browser wait 500` before the screenshot, since the toggle animates its colors. Plain `snapshot` shows `radio "Yearly" [checked=true]` and Free still reads `$0`.
- **FAQ.** Run `agent-browser click "details > summary"`. Plain `snapshot` shows `DisclosureTriangle "Are there other limits on AI usage?" [expanded=true]` followed by its answer, and `agent-browser eval "document.querySelectorAll('details[open]').length"` prints `1`.
- **Start free.** Run `agent-browser click $($R 'button "Start free"')`. The URL becomes `http://localhost:4335/#download`.
- **Credit pack checkout.** Reopen `/pricing`, wait as in Open, and run `agent-browser click $($R 'button "Buy for $5"')`. The browser goes to `/api/pricing/sign-in?pack=pdt_...` and shows the JSON `{"error":"Sign-in is not configured (missing WORKOS_API_KEY)."}` with status 503. On this machine that is the expected result; report the checkout journey as failed with this reason.
- **Network.** The server log gets `POST .../api/query` from the server render and from the session check, both on the dev host.
- **Mobile.** Run `agent-browser set device "iPhone 14"`, reopen `/pricing`, and wait as in Open. `agent-browser eval "visualViewport.width"` prints `390`, and the cards stack in one column.
- **Proof.** Screenshot each step, and the whole page at 1440 px and at `iPhone 14`.

## Gotchas

- Sign-in needs `WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD` for the WorkOS environment of the dev deployment. Neither exists on this machine, so every page load shows the alert `Sign-in is not configured (missing WORKOS_API_KEY).`, and sign-in, `Manage billing`, checkout recovery and the `?sign_in=failed` and `?checkout=cancel` notices stay unreachable. Ask the user for the keys before claiming any of them.
- Even with keys, dev tiers have no Dodo product IDs, so paid plans stay `Unavailable`, only the credit pack can reach checkout, and prod prices stay unverified.
- Free's monthly usage on dev is `1e121` dollars, which prints as a 121-digit number that overflows into the next card. On `iPhone 14` it widens the page to about 1310 px, so `innerWidth` reads 1310 and the fixed header's `Menu` button sits off screen. That is dev data. Judge layout with a real value from the change's own data, and read the viewport from `visualViewport.width`.
- The FAQ questions also appear in the page's JSON-LD, so `find text "<question>"` can land on the hidden script and refuse to click. `snapshot -i` does not list the summaries either. Click them by CSS.
