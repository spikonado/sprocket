import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';

export const get = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) =>
		await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique()
});

export const remember = internalMutation({
	args: { userId: v.string(), dodoCustomerId: v.string() },
	returns: v.string(),
	handler: async (ctx, { userId, dodoCustomerId }) => {
		const existing = await ctx.db
			.query('billingCustomers')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		if (existing) return existing.dodoCustomerId;

		await ctx.db.insert('billingCustomers', { userId, dodoCustomerId });

		return dodoCustomerId;
	}
});
