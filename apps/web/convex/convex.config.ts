import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import exa from '@exalabs/convex-exa/convex.config';
import workpool from '@convex-dev/workpool/convex.config';
import posthog from '@posthog/convex/convex.config';

const app = defineApp({
	env: {
		DODO_PAYMENTS_API_KEY: v.optional(v.string()),
		DODO_PAYMENTS_ENVIRONMENT: v.optional(v.string()),
		DODO_PAYMENTS_WEBHOOK_SECRET: v.optional(v.string()),
		DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS: v.optional(v.string()),
		SPROCKET_MARKETING_ORIGIN: v.optional(v.string()),
		SPROCKET_BILLING_STAGING_ORIGIN: v.optional(v.string()),
		EXA_API_KEY: v.string(),
		CONTEXT_DEV_API_KEY: v.string(),
		FIRECRAWL_API_KEY: v.string(),
		WORKOS_CLIENT_ID: v.string(),
		WORKOS_API_KEY: v.optional(v.string()),
		// Sandbox credentials on dev and preview deployments, live ones on production.
		AGENTCARD_CLIENT_ID: v.optional(v.string()),
		AGENTCARD_CLIENT_SECRET: v.optional(v.string()),
		AGENTCARD_WEBHOOK_SECRET: v.optional(v.string()),
		MODEL_GATEWAY_URL: v.optional(v.string()),
		MODEL_GATEWAY_TOKEN_SECRET: v.optional(v.string()),
		// Dev and preview deployments use a dummy token; their sends fail.
		POSTHOG_PROJECT_TOKEN: v.string()
	}
});

app.use(exa, { env: { EXA_API_KEY: app.env.EXA_API_KEY } });

app.use(posthog, {
	env: {
		POSTHOG_PROJECT_TOKEN: app.env.POSTHOG_PROJECT_TOKEN,
		POSTHOG_HOST: 'https://eu.i.posthog.com'
	}
});

app.use(rateLimiter);

app.use(workpool, { name: 'webSearchWorkpool' });

app.use(workpool, { name: 'contextDevWorkpool' });

// Keeps its original name so hosted parses queued before a deploy still run.
app.use(workpool, { name: 'firecrawlScrapeWorkpool' });

app.use(workpool, { name: 'billingWebhookWorkpool' });

app.use(workpool, { name: 'billingReconciliationWorkpool' });

export default app;
