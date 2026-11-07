import { DAY, RateLimiter } from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { QueryCtx } from '@convex/_generated/server';

const rateLimiter = new RateLimiter(components.rateLimiter, {});

const METER_CAPACITY = 4_000_000_000_000_000;

/** Usage the rate limiter counted in a window before the usage table replaced it. */
export async function legacyUsage(
	ctx: QueryCtx,
	userId: string,
	windowStart: number,
	quotaResetAt: number | undefined
): Promise<number> {
	const bucket = await rateLimiter.getValue(ctx, 'modelUsageMonthly', {
		key: `${userId}:monthly:${windowStart}:${quotaResetAt ?? 0}`,
		config: { kind: 'fixed window', period: 365 * DAY, rate: METER_CAPACITY, start: windowStart }
	});

	return METER_CAPACITY - bucket.value;
}
