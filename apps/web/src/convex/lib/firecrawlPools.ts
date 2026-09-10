import { Workpool } from '@convex-dev/workpool';
import { components } from '@convex/_generated/api';

export const firecrawlScrapePool = new Workpool(components.firecrawlScrapeWorkpool, {
	maxParallelism: 2,
	retryActionsByDefault: false
});

export const firecrawlBrowserPool = new Workpool(components.firecrawlBrowserWorkpool, {
	maxParallelism: 2,
	retryActionsByDefault: false
});
