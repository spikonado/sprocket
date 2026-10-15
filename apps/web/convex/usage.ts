import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vMyUsage } from '@convex/lib/docs';
import { getMeterWindow, usageMeters } from '@convex/lib/rateLimits';
import { getSubscriptionDoc, resolveTier, subscriptionMaterializedTier } from '@convex/lib/tiers';

export const getMyUsage = query({
	args: { now: v.number() },
	returns: vMyUsage,
	handler: async (ctx, args) => {
		const now = args.now;

		if (!Number.isFinite(now)) throw new Error('Usage display time must be finite.');
		const userId = await getUserId(ctx);
		const subscription = await getSubscriptionDoc(ctx, userId);
		const tier = subscriptionMaterializedTier(subscription);
		const { limits, label: tierLabel } = await resolveTier(ctx, tier);

		const meters = await Promise.all(
			usageMeters.map(async (meter) => {
				const window = await getMeterWindow(ctx, meter.id, userId, limits, subscription, now);

				return {
					id: meter.id,
					label: meter.label,
					description: meter.description,
					...window,
					windows: [{ period: 'monthly' as const, ...window }]
				};
			})
		);

		// Sending is blocked while any meter is over its limit; report the meter
		// that unlocks last so clients can count down to full access.
		const blockedMeter = meters
			.filter((meter) => meter.used >= meter.limit)
			.sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];

		return {
			tier,
			tierLabel,
			exhausted: blockedMeter !== undefined,
			resetsAt: blockedMeter?.resetsAt ?? null,
			meters
		};
	}
});
