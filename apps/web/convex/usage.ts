import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vMyUsage } from '@convex/lib/docs';
import { readUsage } from '@convex/lib/quota';
import { enforcementTier, getSubscriptionDoc, resolveTier } from '@convex/lib/tiers';
import { usageMeters } from '@convex/lib/usageMeters';

export const getMyUsage = query({
	args: { now: v.number() },
	returns: vMyUsage,
	handler: async (ctx, args) => {
		const now = args.now;

		if (!Number.isFinite(now)) throw new Error('Usage display time must be finite.');
		const userId = await getUserId(ctx);
		const subscription = await getSubscriptionDoc(ctx, userId);
		const tier = enforcementTier(subscription, now);
		const { limits, label: tierLabel } = await resolveTier(ctx, tier);
		const { used, resetsAt } = await readUsage(ctx, userId, subscription, now);
		const exhausted = used >= limits.modelUsage;

		return {
			tier,
			tierLabel,
			exhausted,
			resetsAt: exhausted ? resetsAt : null,
			meters: usageMeters.map((meter) => ({
				id: meter.id,
				label: meter.label,
				used,
				limit: limits[meter.id],
				resetsAt
			}))
		};
	}
});
