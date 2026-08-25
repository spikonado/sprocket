'use node';

import { v, type Infer } from 'convex/values';
import { ContextDev } from '@context-dot-dev/convex';
import { ExaClient } from '@exalabs/convex-exa';
import { action } from '@convex/_generated/server';
import { api, components } from '@convex/_generated/api';
import { vScrapeUrlResult, vWebSearchResult } from '@convex/lib/validators';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';

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

// Context.dev validates its scrape result against a bounded-depth JSON schema,
// so pages whose metadata nests deeper than the bound fail inside the component
// before any content reaches us (#208).
export function isUnparseablePageFailure(error: Error): boolean {
	return error.message.includes('ReturnsValidationError');
}

const UNPARSEABLE_PAGE_ERROR = 'The webpage is too complex and failed to parse as markdown.';

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
		if (error instanceof Error && isUnparseablePageFailure(error)) {
			// The same page fails validation on every attempt.
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
		try {
			const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
				runId: args.runId,
				executionSecret: args.executionSecret
			});
			if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
				throw new Error('Run is no longer active.');
			}
			let url: URL;
			try {
				url = new URL(args.url.trim());
			} catch {
				throw new Error(`Invalid URL: ${args.url}`);
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				throw new Error('Only http(s) URLs can be scraped.');
			}

			let response: Awaited<ReturnType<typeof contextDev.scrapeMarkdown>>;
			try {
				response = await callComponent('Context.dev scrape', SCRAPE_TIMEOUT_MS, () =>
					contextDev.scrapeMarkdown(ctx, {
						params: {
							url: url.toString(),
							useMainContentOnly: true,
							timeoutMS: SCRAPE_TIMEOUT_MS
						}
					})
				);
			} catch (error) {
				if (error instanceof Error && isUnparseablePageFailure(error)) {
					throw new Error(UNPARSEABLE_PAGE_ERROR, { cause: error });
				}
				throw error;
			}

			const truncated = response.markdown.length > SCRAPE_MARKDOWN_MAX_CHARS;
			return {
				url: response.url,
				markdown: truncated
					? response.markdown.slice(0, SCRAPE_MARKDOWN_MAX_CHARS)
					: response.markdown,
				truncated
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
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
		try {
			const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
				runId: args.runId,
				executionSecret: args.executionSecret
			});
			if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
				throw new Error('Run is no longer active.');
			}
			const query = args.query.trim();
			if (!query) {
				throw new Error('Search query cannot be empty.');
			}
			const requested =
				args.numResults !== undefined && Number.isFinite(args.numResults)
					? Math.floor(args.numResults)
					: DEFAULT_SEARCH_RESULTS;
			const numResults = Math.min(Math.max(requested, 1), MAX_SEARCH_RESULTS);

			const response = await callComponent('Exa search', SEARCH_TIMEOUT_MS, () =>
				exa.search(ctx, {
					query,
					type: 'auto',
					numResults,
					contents: { text: { maxCharacters: SEARCH_RESULT_TEXT_MAX_CHARS } }
				})
			);

			return {
				results: response.results.flatMap((result) => {
					if (!result.url) {
						return [];
					}
					const item: Infer<typeof vWebSearchResult>['results'][number] = {
						url: result.url
					};
					if (result.title) item.title = result.title;
					if (result.publishedDate) item.publishedDate = result.publishedDate;
					if (result.author) item.author = result.author;
					if (result.text) item.text = result.text;
					return [item];
				})
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
