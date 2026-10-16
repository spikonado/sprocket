import { Workpool } from '@convex-dev/workpool';
import { components } from '@convex/_generated/api';

/** context.dev Free plan concurrency. */
export const CONTEXT_DEV_MAX_PARALLELISM = 1;

export const FIRECRAWL_MAX_PARALLELISM = 2;

export const contextDevPool = new Workpool(components.contextDevWorkpool, {
	maxParallelism: CONTEXT_DEV_MAX_PARALLELISM,
	retryActionsByDefault: false
});

/** Shared by hosted OCR and developer_search. */
export const firecrawlPool = new Workpool(components.firecrawlScrapeWorkpool, {
	maxParallelism: FIRECRAWL_MAX_PARALLELISM,
	retryActionsByDefault: false
});
