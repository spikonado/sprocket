# Sprocket site verification map

One recipe per visitor-facing feature of the marketing site. Update a file in the same change that alters the page it describes.

## Baseline preconditions

- Launched, `doctor.sh` exits 0, and the HAR is recording, all as in `SKILL.md`.
- The browser is on `http://localhost:4335/` with the dev toolbar hidden.
- Re-snapshot after every navigation or hot reload.

## Proof and skip reporting

Proof follows Evidence in `SKILL.md`. Report an unreachable path as a failure with the command run and the unmet precondition, and record it in that feature's Gotchas. A journey passes only through the entry point it names, at both the desktop and the mobile viewport when its file lists both.

## Features

- [Home](./home.md): hero, release badge, download button and platform links, copy command, screenshot dialog, showcase sections, the closing install section.
- [Navigation](./navigation.md): desktop navbar, mobile menu, footer links, skip link.
- [Pricing](./pricing.md): the live plan catalog from Convex, the billing interval, plan and credit pack CTAs, FAQ, sign-in and checkout.
- [Share images](./share-images.md): `/og.png`, `/apple-touch-icon.png`, and the meta tags that point at them.
