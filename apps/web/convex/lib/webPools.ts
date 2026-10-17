import { Workpool } from '@convex-dev/workpool';
import { components } from '@convex/_generated/api';

export const contextDevPool = new Workpool(components.contextDevWorkpool, {
	// context.dev Free plan concurrency.
	maxParallelism: 1,
	retryActionsByDefault: false
});

export const firecrawlPool = new Workpool(components.firecrawlScrapeWorkpool, {
	maxParallelism: 2,
	retryActionsByDefault: false
});
