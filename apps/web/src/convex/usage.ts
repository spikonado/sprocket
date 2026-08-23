import { query } from '@convex/_generated/server';
import { getUserId } from '@convex/lib/auth';
import { vMyUsage } from '@convex/lib/docs';
import { getMeterWindow, usageMeters, usagePeriods } from '@convex/lib/rateLimits';
import { getSubscriptionTier, tierLimits } from '@convex/lib/tiers';

export const getMyUsage = query({
	args: {},
	returns: vMyUsage,
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const tier = await getSubscriptionTier(ctx, userId);
		const limits = tierLimits[tier];
		const meters = await Promise.all(
			usageMeters.map(async (meter) => ({
				id: meter.id,
				label: meter.label,
				description: meter.description,
				windows: await Promise.all(
					usagePeriods.map(async (period) => {
						// Admin skips meters; don't project free/pro remaining onto admin rates.
						if (tier === 'admin') {
							return {
								period,
								used: 0,
								limit: limits[meter.id][period],
								resetsAt: null
							};
						}
						return {
							period,
							...(await getMeterWindow(ctx, meter.id, period, userId, limits))
						};
					})
				)
			}))
		);
		// Sending is blocked while any metered window is over its limit; report the
		// window that unlocks last so clients can count down to full access.
		const blockedWindow = meters
			.flatMap((meter) => meter.windows.map((window) => ({ ...window, meterId: meter.id })))
			.filter((window) => window.limit > 0 && window.used >= window.limit)
			.sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];
		return {
			tier,
			exhausted: blockedWindow !== undefined,
			resetsAt: blockedWindow?.resetsAt ?? null,
			meters
		};
	}
});
