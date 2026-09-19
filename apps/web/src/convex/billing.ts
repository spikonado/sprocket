import { v } from 'convex/values';
import { mutation, query } from '@convex/_generated/server';
import { ensureCurrentUser, getUserId } from '@convex/lib/auth';
import { ensureSubscription, getSubscriptionTier, getTierLabel } from '@convex/lib/tiers';
import { vSubscriptionTier } from '@convex/lib/validators';

export const getMySubscription = query({
	args: {},
	returns: v.object({ tier: vSubscriptionTier, tierLabel: v.string() }),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const tier = await getSubscriptionTier(ctx, userId);
		return { tier, tierLabel: await getTierLabel(ctx, tier) };
	}
});

export const ensureMySubscription = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		await ensureCurrentUser(ctx);
		await ensureSubscription(ctx, userId);
	}
});
