import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import { getPrimaryUser } from '@convex/lib/auth';

export const getDodoCustomerId = internalQuery({
	args: { userId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { userId }) => (await getPrimaryUser(ctx.db, userId))?.dodoCustomerId ?? null
});

export const remember = internalMutation({
	args: { userId: v.string(), dodoCustomerId: v.string() },
	returns: v.string(),
	handler: async (ctx, { userId, dodoCustomerId }) => {
		const user = await getPrimaryUser(ctx.db, userId);

		if (!user) throw new Error(`No user record for ${userId}.`);

		if (user.dodoCustomerId) return user.dodoCustomerId;

		await ctx.db.patch('users', user._id, { dodoCustomerId });

		return dodoCustomerId;
	}
});
