import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import contextDev from '@context-dot-dev/convex/convex.config';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import dodopayments from '@dodopayments/convex/convex.config';
import exa from '@exalabs/convex-exa/convex.config';
import migrations from '@convex-dev/migrations/convex.config';
import aggregate from '@convex-dev/aggregate/convex.config';
import workflow from '@convex-dev/workflow/convex.config';
import actionRetrier from '@convex-dev/action-retrier/convex.config';
import workpool from '@convex-dev/workpool/convex.config';

const app = defineApp({
	env: {
		CONTEXT_DEV_API_KEY: v.string(),
		EXA_API_KEY: v.string(),
		WORKOS_CLIENT_ID: v.string(),
		OPENAI_API_KEY: v.optional(v.string()),
		BROWSERBASE_API_KEY: v.optional(v.string()),
		BROWSERBASE_PROJECT_ID: v.optional(v.string()),
		BROWSER_TASK_MODEL: v.optional(v.string()),
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

app.use(contextDev, { env: { CONTEXT_DEV_API_KEY: app.env.CONTEXT_DEV_API_KEY } });
app.use(exa, { env: { EXA_API_KEY: app.env.EXA_API_KEY } });
app.use(rateLimiter);
app.use(dodopayments);
app.use(migrations);
app.use(aggregate);
app.use(workflow);
app.use(actionRetrier);
app.use(workpool, { name: 'webToolWorkpool' });

export default app;
