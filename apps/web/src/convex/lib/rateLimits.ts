import {
	DAY,
	HOUR,
	MINUTE,
	RateLimiter,
	SECOND,
	WEEK,
	isRateLimitError,
	type RateLimitConfig,
	type RunMutationCtx
} from '@convex-dev/rate-limiter';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type ActionCtx } from '@convex/_generated/server';
import { v } from 'convex/values';

const MONTH = 30 * DAY;

const hourlyModelCompletionLimit = 300;
const weeklyUrlScrapeLimit = 100;
const monthlyUrlScrapeLimit = 280;
const weeklyWebSearchLimit = 25;
const monthlyWebSearchLimit = 60;

const rateLimitConfigs = {
	modelCompletion: {
		kind: 'fixed window',
		period: HOUR,
		rate: hourlyModelCompletionLimit
	},
	urlScrapeWeekly: {
		kind: 'fixed window',
		period: WEEK,
		rate: weeklyUrlScrapeLimit
	},
	urlScrapeMonthly: {
		kind: 'fixed window',
		period: MONTH,
		rate: monthlyUrlScrapeLimit
	},
	webSearchWeekly: {
		kind: 'fixed window',
		period: WEEK,
		rate: weeklyWebSearchLimit
	},
	webSearchMonthly: {
		kind: 'fixed window',
		period: MONTH,
		rate: monthlyWebSearchLimit
	}
} satisfies Record<string, RateLimitConfig>;

export const rateLimiter = new RateLimiter(components.rateLimiter, rateLimitConfigs);

type RateLimitName = keyof typeof rateLimitConfigs;
type PairedLimit = { name: RateLimitName; label: string };

const urlScrapeLimits: ReadonlyArray<PairedLimit> = [
	{ name: 'urlScrapeMonthly', label: 'URL scrape monthly limit' },
	{ name: 'urlScrapeWeekly', label: 'URL scrape weekly limit' }
];

const webSearchLimits: ReadonlyArray<PairedLimit> = [
	{ name: 'webSearchMonthly', label: 'Web search monthly limit' },
	{ name: 'webSearchWeekly', label: 'Web search weekly limit' }
];

function formatRetryAfter(milliseconds: number): string {
	let remaining = Math.max(SECOND, Math.ceil(milliseconds / SECOND) * SECOND);
	const days = Math.floor(remaining / DAY);
	remaining %= DAY;
	const hours = Math.floor(remaining / HOUR);
	remaining %= HOUR;
	const minutes = Math.floor(remaining / MINUTE);
	remaining %= MINUTE;
	const seconds = remaining / SECOND;
	const parts: string[] = [];

	if (days > 0) {
		parts.push(`${days}d`);
	}
	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}

	return parts.join(' ');
}

function rateLimitError(label: string, retryAfter: number, cause?: unknown): Error {
	return new Error(`${label} reached. Try again in ${formatRetryAfter(retryAfter)}.`, {
		cause
	});
}

async function enforceLimit(
	ctx: RunMutationCtx,
	name: RateLimitName,
	key: string,
	label: string
): Promise<void> {
	try {
		await rateLimiter.limit(ctx, name, {
			key,
			throws: true
		});
	} catch (error) {
		if (!isRateLimitError(error)) {
			throw error;
		}

		throw rateLimitError(label, error.data.retryAfter, error);
	}
}

/**
 * Check and consume both windows in one mutation so a denial on either rolls
 * back the other consume.
 */
async function enforcePairedLimits(
	ctx: RunMutationCtx,
	limits: ReadonlyArray<PairedLimit>,
	key: string
): Promise<void> {
	const statuses = await Promise.all(
		limits.map(async ({ name, label }) => {
			const status = await rateLimiter.check(ctx, name, { key });
			return { label, status };
		})
	);

	let blocked: { label: string; retryAfter: number } | undefined;
	for (const { label, status } of statuses) {
		if (!status.ok) {
			if (blocked === undefined || status.retryAfter > blocked.retryAfter) {
				blocked = { label, retryAfter: status.retryAfter };
			}
		}
	}

	if (blocked !== undefined) {
		throw rateLimitError(blocked.label, blocked.retryAfter);
	}

	for (const { name, label } of limits) {
		await enforceLimit(ctx, name, key, label);
	}
}

export const consumeUrlScrapeLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await enforcePairedLimits(ctx, urlScrapeLimits, args.userId);
	}
});

export const consumeWebSearchLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await enforcePairedLimits(ctx, webSearchLimits, args.userId);
	}
});

export async function enforceModelCompletionLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await enforceLimit(ctx, 'modelCompletion', userId, 'Model completion limit');
}

export async function enforceUrlScrapeLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await ctx.runMutation(internal.lib.rateLimits.consumeUrlScrapeLimits, { userId });
}

export async function enforceWebSearchLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await ctx.runMutation(internal.lib.rateLimits.consumeWebSearchLimits, { userId });
}
