import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vMyUsage } from '@convex/lib/docs';
import { getMeterWindow, usageMeters, usagePeriods } from '@convex/lib/rateLimits';
import { getSubscriptionDoc, resolveTier, subscriptionMaterializedTier } from '@convex/lib/tiers';

export const getMyUsage = query({
	args: { now: v.optional(v.number()) },
	returns: vMyUsage,
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();

		if (!Number.isFinite(now)) throw new Error('Usage display time must be finite.');
		const userId = await getUserId(ctx);
		const subscription = await getSubscriptionDoc(ctx, userId);
		const tier = subscriptionMaterializedTier(subscription);
		const { limits, label: tierLabel } = await resolveTier(ctx, tier);

		const meters = await Promise.all(
			usageMeters.map(async (meter) => ({
				id: meter.id,
				label: meter.label,
				description: meter.description,
				windows: await Promise.all(
					usagePeriods.map(async (period) => ({
						period,
						...(await getMeterWindow(ctx, meter.id, period, userId, limits, subscription, now))
					}))
				)
			}))
		);

		// Sending is blocked while any metered window is over its limit; report the
		// window that unlocks last so clients can count down to full access.
		const blockedWindow = meters
			.flatMap((meter) => meter.windows.map((window) => ({ ...window, meterId: meter.id })))
			.filter((window) => window.used >= window.limit)
			.sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];

		return {
			tier,
			tierLabel,
			exhausted: blockedWindow !== undefined,
			resetsAt: blockedWindow?.resetsAt ?? null,
			meters
		};
	}
});
