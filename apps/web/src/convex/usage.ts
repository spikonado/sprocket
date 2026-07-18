import { query } from '@convex/_generated/server';
import { getUserId } from '@convex/lib/auth';
import { getMeterWindow, usageMeters, usagePeriods } from '@convex/lib/rateLimits';
import { getSubscriptionTier, tierLimits } from '@convex/lib/tiers';

export const getMyUsage = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const tier = await getSubscriptionTier(ctx, userId);
		const limits = tierLimits[tier];
		return {
			tier,
			meters: await Promise.all(
				usageMeters.map(async (meter) => ({
					id: meter.id,
					label: meter.label,
					windows: await Promise.all(
						usagePeriods.map(async (period) => ({
							period,
							...(await getMeterWindow(ctx, meter.id, period, userId, limits))
						}))
					)
				}))
			)
		};
	}
});
