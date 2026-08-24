---
name: ucp-shopping
description: Shop at online stores that speak the Universal Commerce Protocol (UCP); run discovery, cart, and checkout over UCP's REST API and pay with Prava mandate credentials. Use when the user asks to buy, order, or purchase something online, wants to track an order, or mentions UCP or agentic checkout.
---

# Shopping via UCP

UCP lets an agent run the whole purchase with a store that publishes a profile at `/.well-known/ucp`. Product discovery, cart building, checkout, and order tracking all happen over its REST API.
Prefer UCP for every step the store supports, pay with a Prava mandate credential, and only fall back to the browser for a step you can't finish using UCP.
This skill is the UCP protocol and the order to wire the tools together; the tool descriptions cover what each tool does.

Drive UCP with `curl` via `exec_command`, piping responses through `jq`.
All UCP money amounts are in minor units (cents); convert to major units in everything you show the user.

## 1. Discovery

```bash
curl -s https://<store-domain>/.well-known/ucp | jq .
```

From `ucp.services["dev.ucp.shopping"]` pick the entry with `"transport": "rest"` and note its `endpoint`. Every call below is `{endpoint}<path>`.
Note `ucp.capabilities` (checkout, catalog.search, fulfillment, discount, order, …).
Extensions are self-describing: to use one, fetch its `schema` URL from the profile.
A 404 means the store doesn't speak UCP. Fall back to its normal website.

## 2. Find products

- If `dev.ucp.shopping.catalog.search` is advertised, search with `POST {endpoint}/catalog/search` (`{"query": "...", "filters": {...}}`), and fetch full detail with `dev.ucp.shopping.catalog.lookup`.
  Variant IDs from catalog responses go straight into checkout `line_items[].item.id`.
- If searching for products through UCP doesn't work well, you can only use the other web tools provided to you.

Done when: the user has confirmed the exact items (variant, quantity, price).

## 3. Create the checkout

```bash
curl -s -X POST "{endpoint}/checkout-sessions" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Request-Id: $(uuidgen)" \
  -d '{"line_items": [{"item": {"id": "<item_id>"}, "quantity": 1}]}' | jq .
```

Include `buyer` (email, name) and `context` (country, postal code) early for converging totals faster.
You are a profileless agent and can't add `UCP-Agent: profile="<url>"` to the request.
A store that rejects profileless agents should be paid on using your browser tools.

Done when: you hold the checkout `id` and its current `status`.

## 4. Drive the status loop

Read `status` and `messages[]` after every response:

| status                 | your move                                    |
| ---------------------- | -------------------------------------------- |
| `incomplete`           | Fix what `messages` flags and PUT an update  |
| `requires_escalation`  | Hand off: give the user `continue_url`       |
| `ready_for_complete`   | Go to review (step 6)                        |
| `complete_in_progress` | Poll `GET {endpoint}/checkout-sessions/{id}` |
| `completed`            | Report the order (step 7)                    |
| `canceled`             | Session is dead; start a new one             |

Update is a **full replacement**: `PUT {endpoint}/checkout-sessions/{id}` with the same headers, resending every field you want kept (line items with their `id`s, buyer, fulfillment) plus your change.
For fulfillment, send the address under `fulfillment.methods[].destinations`, then select from the returned IDs via `selected_destination_id` / `selected_option_id`.

`messages[].severity` tells you how hard to push:

- `recoverable`: fix the field at `path`, update, retry.
- `requires_buyer_input` / `requires_buyer_review`: hand off.
- `unrecoverable`: stop; start a new session or hand off.

Codes worth naming to the user: `out_of_stock`, `item_unavailable`, `address_undeliverable`, `payment_failed`.

Done when: status is `ready_for_complete`, or you have handed off.

## 5. Pay with a Prava mandate

The checkout's `payment.instruments[]` take a tokenized credential, which you get from a Prava mandate.
Check `mandate_list` for an `active` mandate that covers the total and currency (`listed` scope is locked to one merchant; `any` works anywhere).
If none fits, use `mandate_setup` and have the user approve it, then `mandate_charge` for the checkout's total in its currency.

## 6. Review, then complete

After ensuring that you confirmed all checkout details at some point in your conversation with the user, complete the checkout using the following:

```bash
curl -s -X POST "{endpoint}/checkout-sessions/{id}/complete" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"payment": {"instruments": [{"handler_id": "<id>", "type": "card",
       "credential": {"type": "network_token", "token": "<token>",
       "dynamic_cvv": "<dynamicCvv>", "expiry_month": "<expiryMonth>",
       "expiry_year": "<expiryYear>"}}]}}' | jq .
```

The credential fields come straight from the `mandate_charge` result (camelCase there, snake_case here).
Match `handler_id`/`type` to a negotiated payment handler that accepts network tokens.
Retry failed calls with the **same** Idempotency-Key. Retrying complete with a fresh key can place the order twice; a 409 means the key was reused with a different payload.

## 7. Report and track

- Report the charge outcome with `mandate_report` once the order resolves.
- On `completed`, give the user `order.id` and `order.permalink_url`.
- If the store advertises `dev.ucp.shopping.order`, later status checks are
  `GET {endpoint}/orders/{id}`: `fulfillment.events` carry tracking numbers,
  `adjustments` carry refunds.

## Switching to browser tools

If doing something with UCP doesn't work well, you can always switch to using your browser tools to complete the checkout. It's recommended to use the UCP `continue_url`.
