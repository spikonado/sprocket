import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import contextDev from '@context-dot-dev/convex/convex.config';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import dodopayments from '@dodopayments/convex/convex.config';
import exa from '@exalabs/convex-exa/convex.config';

const app = defineApp({
	env: {
		CONTEXT_DEV_API_KEY: v.string(),
		EXA_API_KEY: v.string()
	}
});

app.use(contextDev, { env: { CONTEXT_DEV_API_KEY: app.env.CONTEXT_DEV_API_KEY } });
app.use(exa, { env: { EXA_API_KEY: app.env.EXA_API_KEY } });
app.use(rateLimiter);
app.use(dodopayments);

export default app;
