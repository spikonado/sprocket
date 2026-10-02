# Billing rollout

New checkout stays disabled until these gates have recorded results. Deploy additive backend state and migrations before the website. Do not interpret passing unit tests as provider or deployment validation.

## Configuration and provider gates

- Set explicit matching Dodo environment, API key, signing secret, marketing return origin, and website checkout mode. Keep `DODO_CHECKOUT_ENABLED=false` until approval. Portal repair must work while checkout is disabled.
- Approve an HTTPS staging origin before setting `SPROCKET_BILLING_STAGING_ORIGIN` or registering WorkOS CORS and `/pricing/callback`. Keep credentials private and obtain fresh test credentials; do not reuse a previously shared key without checking rotation/status.
- Audit every tier/product for publication, unique interval ownership, prices/currencies, supported recurrence, trials, taxes/discounts/regional pricing, and collection membership. Every existing tier row remains public pending an operator-approved publication migration; do not automatically publish internal plans or silently delist existing ones.
- Obtain explicit approval for business-wide settings, shared by test and live mode: multiple subscriptions off, pause off, payment-failure grace off, scheduled cancellation on, immediate cancellation off, plan-change payment links on. Check overrides on both collections.
- Separate monthly and annual collections. Upgrades use immediate + `prorated_immediately` + `prevent_change`. Downgrades use Next billing date + `full_immediately`; nothing is charged when scheduled.

## Behavioral gates

Use signed subscription status for payment correlation, not a generic `payment.failed` event: Dodo documents `subscription.failed` as mandate-creation failure and `on_hold` as failed renewal. Failed/abandoned `prevent_change` upgrade payments leave the authoritative product/status intact. Historical term failures cannot override a newer confirmed term. An unexpected mandate failure for an established subscription remains an unresolved incident requiring retrieval, not a downgrade. Verify these semantics with real portal payments before launch.

- Signed invalid/duplicate/reversed/equal/concurrent events, unresolved mapping repair/replay, unsupported pause/state observability, identity supersession, and webhook outage recovery.
- Exact one-hour processing deadline with old monthly usage preserved, including exhausted allowance, confirmed failure cutoff, cancellation with no grace, stale scheduler/fetch fences, and portal-only payment repair.
- Monthly and annual purchases, January 31/leap-year/short/extended term boundaries, effective plan-change resets including equal-allowance tiers, scheduled downgrade replacement/cancellation and actual renewal.
- Successful, failed, abandoned, and zero-charge portal upgrades. Verify provider charges and Sprocket projection together.
- Two still-payable selections for the same saved customer completed sequentially and concurrently. At most one billable subscription must exist; competing subscription incidents must be visible. Failure blocks launch.
- Cancel to authoritative terminal state to new interval purchase in both directions; no overlap, credit transfer, or seamless conversion claim.
- Browser sign-out/account replacement during delayed checkout/portal operations, stale progress, forged returns, reload recovery, bounded neutral confirmation feedback, and idempotent retry.
- Measure provider request budgets under concurrent cold cache, partial failures, negative-cache backoff, expired leases, checkout timeout/recovery, and reconciliation failure.

Cancel/archive disposable provider resources after approved tests. Record outcomes without credentials, customer details, or hosted payment links.

## Support ownership

Billing support is **aarav@spikonado.com**, approved by the operator. Verify email delivery and name the responsible inbox owner before rollout. The customer portal manages subscriptions, payment methods, invoices, and refund history; it is not a documented refund-request or chargeback interface.

Locate a payment in Dodo and use **Payment Details → Initiate Refund** for full/partial refunds. Decide separately whether to cancel future subscription billing. A refund alone does not cancel the subscription or alter Convex allowances. Confirm support recipients and refund/dispute email preferences under **Settings → Communication**.

Monitor email and **Transactions → Disputes**. [Official dispute documentation](https://docs.dodopayments.com/features/transactions/disputes), checked 2026-10-02, specifies **10 days from creation** to respond; verify the current dashboard countdown at rollout. Accept or counter in Dodo with the required evidence. Inspect **Settings → Dispute Resolution** and obtain approval before changing Visa RDR or Ethoca policies. RDR may refund automatically; enrolled Ethoca alerts may refund and cancel linked subscriptions immediately. Ordinary subscription events still apply those cancellations. No Sprocket refund/dispute handlers, tables, or custom notification service are required.

## Deployment and recovery

Obtain Dodo's confirmed checkout idempotency retention guarantee before setting
`DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS`. No retention duration was established by
the implementation's documentation check. Without this guarantee, ambiguous
creates stay blocked for provider/support reconciliation; status lookup never
POSTs a checkout. The first-create time never moves on retry. After the window
ends, do not retry POSTs or clear an unresolved attempt based on local expiry.

Checkout history is capped at 25 retained selections per account regardless of
local TTL. Terminal rows are compacted and retained for 30 days; never-sent rows
expire after TTL plus 30 days. The daily paginated cleanup preserves ambiguous,
legacy-unknown, and provider-payable rows. Resolve those with provider evidence,
not speculative deletion, before making room for more selections.

Webhook cleanup completes a fixed ingestion snapshot in bounded scheduled batches.
Settled payloads expire after 48 hours; pending and problem-event payloads remain
available for processing/repair until the finite 14-day replay horizon. All rows
expire at that horizon. Alert and resolve backlog before it expires; after expiry,
recover from provider evidence rather than assuming local replay is possible.

Inspect `subscriptionReconciliation:getReconciliation` by subscription row ID for the latest durable `pending`/`completed`/`exhausted` chain. After fixing an exhausted incident, invoke protected `queueReconciliation` with the current subscription/provider identity and projection revision, plus `replay: true`. Duplicate chain starts coalesce; a changed projection or access boundary may initiate fresh bounded recovery. These records contain no provider responses or hosted URLs.

1. Complete migrations and deploy Convex first. Verify signing, processing/replay, mappings, access boundary jobs, protected operator lookup, provider request budgets, and generated website contract compatibility.
2. Configure an operator-visible monitoring signal from existing Convex logs for webhook backlog, unresolved ownership/mapping, unsupported transitions, exhausted processing/reconciliation, competing subscriptions, and grace exhaustion. Assign a responder and exercise repair/replay. Do not log payloads, secrets, unnecessary customer data, or ephemeral hosted URLs.
3. Deploy the website with approved matching origins/mode. Smoke-test sign-in, catalog, portal repair, authorized attempt recovery, and activation against the actual backend.
4. Enable live checkout only after all required gates pass and explicit rollout approval is recorded.

Rollback new purchases with `DODO_CHECKOUT_ENABLED=false`. Keep ingestion, reconciliation, portal repair, ledger lookup, and backwards-compatible APIs active. Do not delete billing history, remove additive fields, or roll back data migrations to stop checkout. Monitor request volume/cost and unresolved events after rollout.

## Unapproved / not executed by implementation

Staging origin, deployment changes, fresh provider credentials, merchant-wide settings, live transactions, provider end-to-end tests, notification recipients/preferences, monitoring configuration, and named support/on-call ownership require operator confirmation. Their presence in this checklist is not evidence they passed.
