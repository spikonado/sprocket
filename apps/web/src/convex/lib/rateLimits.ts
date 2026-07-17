import {
	HOUR,
	RateLimiter,
	isRateLimitError,
	type RateLimitConfig
} from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { ActionCtx } from '@convex/_generated/server';

const hourlyModelCompletionLimit = 300;
const hourlyWebToolLimit = 600;

const rateLimitConfigs = {
	modelCompletion: {
		kind: 'fixed window',
		period: HOUR,
		rate: hourlyModelCompletionLimit
	},
	webTool: {
		kind: 'fixed window',
		period: HOUR,
		rate: hourlyWebToolLimit
	}
} satisfies Record<string, RateLimitConfig>;

export const rateLimiter = new RateLimiter(components.rateLimiter, rateLimitConfigs);

function formatRetryAfter(milliseconds: number): string {
	const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];

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

async function enforceLimit(
	ctx: ActionCtx,
	name: keyof typeof rateLimitConfigs,
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

		throw new Error(`${label} reached. Try again in ${formatRetryAfter(error.data.retryAfter)}.`, {
			cause: error
		});
	}
}

export async function enforceModelCompletionLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await enforceLimit(ctx, 'modelCompletion', userId, 'Model completion limit');
}

export async function enforceWebToolLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await enforceLimit(ctx, 'webTool', userId, 'Web tool limit');
}
