# AI gateway contracts

Versioned HTTP and Convex quota contracts for `spikonado/ai-gateway`.
The gateway does not import Convex generated types. Both repos validate these
shapes at runtime and pin them with the JSON fixtures in `fixtures/`.

Production origin: `https://ai-gateway.spikonado.com`. OpenAI-compatible routes
are under `/api/`. `/health` and `/ready` stay on the origin for the ALB.

## Versions

- `protocolVersion`: `1`
- `catalogVersion`: opaque string owned by the gateway (currently `"1"`)

## Endpoints

| Method | Path                       | Role                                          |
| ------ | -------------------------- | --------------------------------------------- |
| `GET`  | `/api/v1/models`           | Catalog authority. Unauthenticated.           |
| `POST` | `/api/v1/responses`        | OpenAI Responses API. Bearer user credential. |
| `POST` | `/api/v1/chat/completions` | OpenAI Chat Completions compatibility.        |
| `GET`  | `/health`                  | Unadvertised ALB liveness.                    |
| `GET`  | `/ready`                   | Unadvertised ALB readiness.                   |

`Authorization: Bearer <gateway-token>` is required on both completion endpoints.
The token is a user-scoped HMAC credential minted by Convex after a valid run
claim: `{ v: 1, userId, exp }`, 12-hour TTL, presented as the OpenAI API key.
Convex execution secrets and WorkOS tokens never go to the gateway.

The request body is the OpenAI Responses (or Chat Completions) document. There
are no Sprocket protocol fields on the completion request.

## Catalog (`GET /api/v1/models`)

OpenAI list envelope plus a `sprocket` object. See `fixtures/catalog.json`.

Convex actions fetch this document for UI and entitlements at run creation.
Usage weights stay in the gateway; Convex does not charge from them.

## Convex quota (token-authenticated)

Gateway calls these Convex functions with the bearer token in `token`. No user
JWT and no execution secret. Convex stores remaining quota only. It does not
store token counts, model usage rows, or consumption rates.

| Function               | Kind     | Role                                               |
| ---------------------- | -------- | -------------------------------------------------- |
| `gateway:checkQuota`   | mutation | Verify token, return `{ userId, tier, exhausted }` |
| `gateway:consumeQuota` | mutation | Verify token, debit `units` from the user's quota  |

See `fixtures/check-quota.json` and `fixtures/consume-quota.json`.
The gateway converts provider token usage into `units` using catalog rates,
then sends only that number.
