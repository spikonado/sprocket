import { v } from 'convex/values';
import { internalQuery } from '@convex/_generated/server';
import { getSubscriptionDoc } from '@convex/lib/tiers';

export const get = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) =>
		await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique()
});

export const getByDodoId = internalQuery({
	args: { dodoCustomerId: v.string() },
	handler: async (ctx, { dodoCustomerId }) =>
		await ctx.db
			.query('billingCustomers')
			.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', dodoCustomerId))
			.unique()
});

export const getManageable = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		const subscription = await getSubscriptionDoc(ctx, userId);
		if (subscription?.status !== 'active' || !subscription.dodoSubscriptionId) {
			return null;
		}
		return await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
	}
});
