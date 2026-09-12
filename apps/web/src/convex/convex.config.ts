import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import firecrawl from '@firecrawl/firecrawl-convex/convex.config';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import dodopayments from '@dodopayments/convex/convex.config';
import exa from '@exalabs/convex-exa/convex.config';
import migrations from '@convex-dev/migrations/convex.config';
import aggregate from '@convex-dev/aggregate/convex.config';
import actionRetrier from '@convex-dev/action-retrier/convex.config';
import workpool from '@convex-dev/workpool/convex.config';

const app = defineApp({
	env: {
		EXA_API_KEY: v.string(),
		FIRECRAWL_API_KEY: v.string(),
		FIRECRAWL_BROWSER_API_KEY: v.optional(v.string()),
		WORKOS_CLIENT_ID: v.string(),
		PRAVA_SECRET_KEY: v.optional(v.string()),
		PRAVA_BACKEND_URL: v.union(
			v.literal('https://sandbox.api.prava.space'),
			v.literal('https://api.prava.space')
		),
		DODO_PAYMENTS_API_KEY: v.optional(v.string()),
		DODO_PAYMENTS_ENVIRONMENT: v.optional(v.union(v.literal('live_mode'), v.literal('test_mode'))),
		MODEL_GATEWAY_URL: v.optional(v.string()),
		MODEL_GATEWAY_TOKEN_SECRET: v.optional(v.string())
	}
});

app.use(firecrawl, { env: { FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY } });
app.use(exa, { env: { EXA_API_KEY: app.env.EXA_API_KEY } });
app.use(rateLimiter);
app.use(dodopayments);
app.use(migrations);
app.use(aggregate);
app.use(actionRetrier);
app.use(workpool, { name: 'webToolWorkpool' });
app.use(workpool, { name: 'firecrawlScrapeWorkpool' });
app.use(workpool, { name: 'firecrawlBrowserWorkpool' });

export default app;
