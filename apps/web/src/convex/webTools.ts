'use node';

import { v } from 'convex/values';
import { ContextDev } from '@context-dot-dev/convex';
import { ExaClient } from '@exalabs/convex-exa';
import { action } from '@convex/_generated/server';
import { api, components } from '@convex/_generated/api';
import {
	chargeUrlScrapeUsage,
	chargeWebSearchUsage,
	checkWebToolsLimit
} from '@convex/lib/rateLimits';
import { vScrapeUrlResult, vWebSearchResult } from '@convex/lib/validators';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';

const contextDev = new ContextDev(components.contextDev);
const exa = new ExaClient(components.exa);

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const RETRY_DELAY_MS = 1_000;
// Bounds the persisted executor-job result; Convex documents are capped at 1 MiB.
const SCRAPE_MARKDOWN_MAX_CHARS = 40_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const SEARCH_RESULT_TEXT_MAX_CHARS = 2_000;
const SEARCH_TIMEOUT_MS = 30_000;

class WebToolTimeout extends Error {}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(label: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new WebToolTimeout(`${label} timed out after ${timeoutMs}ms.`)),
			timeoutMs
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The components issue a single fetch with no client-side deadline or retry;
 * bound each call here and retry non-timeout failures once. */
async function callComponent<T>(
	label: string,
	timeoutMs: number,
	run: () => Promise<T>
): Promise<T> {
	try {
		return await withTimeout(label, timeoutMs, run());
	} catch (error) {
		if (error instanceof WebToolTimeout) {
			throw error;
		}
		await sleep(RETRY_DELAY_MS);
		return await withTimeout(label, timeoutMs, run());
	}
}

export const scrapeUrl = action({
	args: {
		url: v.string(),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vScrapeUrlResult,
	handler: async (ctx, args) => {
		const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: args.runId,
			executionSecret: args.executionSecret
		});
		if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
			throw new Error('Run is no longer active.');
		}
		const { userId } = actor;
		let url: URL;
		try {
			url = new URL(args.url.trim());
		} catch {
			throw new Error(`Invalid URL: ${args.url}`);
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('Only http(s) URLs can be scraped.');
		}
		await checkWebToolsLimit(ctx, userId);

		const response = await callComponent('Context.dev scrape', SCRAPE_TIMEOUT_MS, () =>
			contextDev.scrapeMarkdown(ctx, {
				params: {
					url: url.toString(),
					useMainContentOnly: true,
					timeoutMS: SCRAPE_TIMEOUT_MS
				}
			})
		);
		await chargeUrlScrapeUsage(ctx, userId);

		const truncated = response.markdown.length > SCRAPE_MARKDOWN_MAX_CHARS;
		return {
			url: response.url,
			markdown: truncated
				? response.markdown.slice(0, SCRAPE_MARKDOWN_MAX_CHARS)
				: response.markdown,
			truncated
		};
	}
});

export const webSearch = action({
	args: {
		query: v.string(),
		numResults: v.optional(v.number()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vWebSearchResult,
	handler: async (ctx, args) => {
		const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: args.runId,
			executionSecret: args.executionSecret
		});
		if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
			throw new Error('Run is no longer active.');
		}
		const { userId } = actor;
		const query = args.query.trim();
		if (!query) {
			throw new Error('Search query cannot be empty.');
		}
		const requested = Number.isFinite(args.numResults)
			? Math.floor(args.numResults as number)
			: DEFAULT_SEARCH_RESULTS;
		const numResults = Math.min(Math.max(requested, 1), MAX_SEARCH_RESULTS);
		await checkWebToolsLimit(ctx, userId);

		const response = await callComponent('Exa search', SEARCH_TIMEOUT_MS, () =>
			exa.search(ctx, {
				query,
				type: 'auto',
				numResults,
				contents: { text: { maxCharacters: SEARCH_RESULT_TEXT_MAX_CHARS } }
			})
		);
		await chargeWebSearchUsage(ctx, userId);

		return {
			results: response.results.flatMap((result) => {
				if (!result.url) {
					return [];
				}
				return [
					{
						url: result.url,
						...(result.title ? { title: result.title } : {}),
						...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
						...(result.author ? { author: result.author } : {}),
						...(result.text ? { text: result.text } : {})
					}
				];
			})
		};
	}
});
