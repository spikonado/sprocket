---
name: paying-at-checkout
description: Buy things online with the user's saved Agentcard card through the store's own checkout in agent-browser. Use when the user asks to buy, order, or pay for something online.
---

# Paying at checkout

You shop on the store's real website with agent-browser, in this thread's browser session. The user's card never reaches you: you type a placeholder card, and Sprocket swaps in the real payment after the user approves it with their passkey.

## 1. Agree on the order

Find the items, then confirm with the user: exact items, quantity, shipping address, shipping method, and the total in the store's currency.

Done when: the user has said yes to that exact order and total.

## 2. Fill the checkout

Fill the store's checkout form in the browser. In the card fields, type the placeholder card:

- Number `4242 4242 4242 4242`
- Any future expiry, such as `12/34`
- Any CVC, such as `123`

Use the store's guest checkout when it has one. Hand off to the user for account logins, CAPTCHAs, and 3-D Secure screens.

Done when: the page shows the final total and a Pay / Place order button, and nothing else is left to fill.

## 3. Pay with `card_checkout`

Call `card_checkout` with the page's final total, its currency, and the Pay button's ref from `snapshot -i`. The tool clicks the button and waits while the user approves.

| status                | your move                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `approved`            | Go to step 4                                                                             |
| `submitted_on_device` | Tell the user to finish payment in the Agentcard popup, then go to step 4                |
| `card_required`       | Ask the user to save a card (Save a card button or Settings → Payments), then call again |
| `declined`, `expired` | Tell the user; call again only if they ask                                               |
| `no_payment_request`  | Check the page for errors or missing fields, fix them, then call again                   |
| `outcome_unknown`     | Stop. Tell the user to check their card and the store before anything else               |

A second `card_checkout` after `approved`, `submitted_on_device`, or `outcome_unknown` can charge the user twice.

## 4. Confirm and report

Wait for the store's confirmation page, read the order number from it, and call `report_order` with the `purchaseId` and that number. Give the user the order number and any tracking link.

Done when: `report_order` succeeded, or you told the user the store showed no confirmation.
