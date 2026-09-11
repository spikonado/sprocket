# AI gateway contracts

Versioned HTTP and Convex quota contracts for `spikonado/ai-gateway`.
The gateway does not import Convex generated types. Both repositories validate
these shapes at runtime and pin them with the JSON fixtures in `fixtures/`.

Production origin: `https://ai-gateway.spikonado.com`. Responses and catalog
routes are under `/api/`. `/health` and `/ready` stay on the origin for the ALB.

## Versions

- `protocolVersion`: `1`
- `catalogVersion`: opaque string owned by the gateway, currently `"8"`

## Gateway credentials

`POST /api/v1/responses` requires `Authorization: Bearer <gateway-token>`.
The token is a user-scoped HMAC credential minted by Convex after a valid run
claim: `{ v: 1, userId, exp }`. It has a 36-hour TTL so a run can do 12 hours
of work before waiting up to 24 hours for a user response. The agent presents
it as the OpenAI API key.
Convex execution secrets and WorkOS tokens never go to the gateway.

The gateway is stateless. Sprocket sends `store: false`, replays complete input
history, and requests `reasoning.encrypted_content`. It preserves each returned
reasoning item in output order and sends its opaque encrypted content back on
the next request. Sprocket's `standard` service tier maps to the Responses API
`default` value. Its `fast` tier maps to `priority`.

## Catalog

`GET /api/v1/models` is unauthenticated and adds a `sprocket` object to the
OpenAI list envelope. See `fixtures/catalog.json`.

The Sprocket UI fetches this document from the browser, so the response includes
CORS. Usage weights stay in the gateway. Convex does not charge from them.

## Convex quota

The gateway calls these Convex functions with the bearer token in `token`. It
does not send a user JWT or execution secret. Convex stores remaining quota,
not token counts, model usage rows, or consumption rates.

| Function               | Kind     | Role                                               |
| ---------------------- | -------- | -------------------------------------------------- |
| `gateway:checkQuota`   | mutation | Verify token, return `{ userId, tier, exhausted }` |
| `gateway:consumeQuota` | mutation | Verify token, debit `units` from the user's quota  |

See `fixtures/check-quota.json` and `fixtures/consume-quota.json`. The gateway
converts provider token usage into `units` using catalog rates, then sends only
that number.
