---
name: convex-billing
description: 'Add Stripe billing/payments to the Convex app via @convex-dev/stripe (checkout + webhook + gating).'
---

<!-- GENERATED from convex-agents content/capabilities/billing.json — do not edit by hand. -->

# Add billing / payments

Wire Stripe to Convex using @convex-dev/stripe: a checkout action, an httpAction webhook registered by the component (signature-verified automatically), subscription state stored in the component's tables, and server-side gating via a query.

## Workflow

1. Install the component: `npm install @convex-dev/stripe`.
2. Create `convex/convex.config.ts`:
   ```ts
   import { defineApp } from 'convex/server';
   import stripe from '@convex-dev/stripe/convex.config.js';
   const app = defineApp();
   app.use(stripe);
   export default app;
   ```
3. Store Stripe keys in Convex env (use the `env` micro power): `STRIPE_SECRET_KEY` (sk_test_… / sk_live_…) and `STRIPE_WEBHOOK_SECRET` (whsec_…).
4. Create `convex/http.ts` to register the webhook route (the component handles signature verification automatically):
   ```ts
   import { httpRouter } from 'convex/server';
   import { components } from './_generated/api';
   import { registerRoutes } from '@convex-dev/stripe';
   const http = httpRouter();
   registerRoutes(http, components.stripe, { webhookPath: '/stripe/webhook' });
   export default http;
   ```
5. Create `convex/billing.ts` with a checkout action and a subscription-gate query:
   <!-- prettier-ignore -->
   ```ts
   import { action, query } from './_generated/server';
   import { components } from './_generated/api';
   import { StripeSubscriptions } from '@convex-dev/stripe';
   import { v } from 'convex/values';
   const stripeClient = new StripeSubscriptions(components.stripe, {});
   const priceByTier = {
     pro: process.env.STRIPE_PRO_PRICE_ID
   } as const;
   export const createSubscriptionCheckout = action({
     args: { tier: v.literal('pro') },
     returns: v.object({ sessionId: v.string(), url: v.union(v.string(), v.null()) }),
     handler: async (ctx, args) => {
       const identity = await ctx.auth.getUserIdentity();
       if (!identity) throw new Error('Not authenticated');
       const priceId = priceByTier[args.tier];
       if (!priceId) throw new Error('Price is not configured');
       const customer = await stripeClient.getOrCreateCustomer(ctx, {
         userId: identity.subject,
         email: identity.email,
         name: identity.name
       });
       return await stripeClient.createCheckoutSession(ctx, {
         priceId,
         customerId: customer.customerId,
         mode: 'subscription',
         successUrl: `${process.env.SITE_URL ?? 'http://localhost:3000'}/?success=true`,
         cancelUrl: `${process.env.SITE_URL ?? 'http://localhost:3000'}/?canceled=true`,
         subscriptionMetadata: { userId: identity.subject, tier: args.tier }
       });
     }
   });
   export const isSubscribed = query({
     args: {},
     returns: v.boolean(),
     handler: async (ctx) => {
       const identity = await ctx.auth.getUserIdentity();
       if (!identity) return false;
       const subscriptions = await ctx.runQuery(
         components.stripe.public.listSubscriptionsByUserId,
         { userId: identity.subject }
       );
       const allowedPriceIds = new Set(Object.values(priceByTier).filter(Boolean));
       return subscriptions.some(
         (sub) =>
           (sub.status === 'active' || sub.status === 'trialing') &&
           allowedPriceIds.has(sub.priceId) &&
           sub.metadata?.tier === 'pro'
       );
     }
   });
   ```
6. Run `npx convex dev --once` — it will install the component and push the functions. Verify output shows `✔ Installed component stripe.`
7. In Stripe Dashboard → Webhooks: add endpoint `https://<deployment>.convex.site/stripe/webhook`, subscribe to `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, `payment_intent.*`. Copy the signing secret as `STRIPE_WEBHOOK_SECRET`.

## Rules

- Use @convex-dev/stripe (npm: @convex-dev/stripe@^0.1.4) — it handles webhook signature verification internally via registerRoutes; do NOT write a manual constructEvent webhook.
- Stripe keys and allowlisted price IDs live in Convex env (use the `env` micro power): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRO_PRICE_ID.
- Accept a validated tier, never a caller-provided Stripe price ID. Gate on server-stored subscription state, status, allowlisted price ID, and tier metadata via isSubscribed.
- convex/convex.config.ts must import from '@convex-dev/stripe/convex.config.js' (not .ts) — the .js extension is required by the Convex bundler.
