import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import { getUserBySubject } from '@convex/lib/auth';

/** The customer's linked user, else the checkout's `userId` metadata, which links the customer. */
export async function resolveCustomerOwner(
	ctx: MutationCtx,
	dodoCustomerId: string,
	metadataUserId: string | undefined
): Promise<string | null> {
	const owner = await ctx.db
		.query('users')
		.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', dodoCustomerId))
		.unique();

	if (owner) return owner.subject;

	const user = metadataUserId ? await getUserBySubject(ctx.db, metadataUserId) : null;

	if (!user || user.dodoCustomerId) return null;
	await ctx.db.patch('users', user._id, { dodoCustomerId });

	return user.subject;
}

export const getDodoCustomerId = internalQuery({
	args: { userId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { userId }) =>
		(await getUserBySubject(ctx.db, userId))?.dodoCustomerId ?? null
});

export const remember = internalMutation({
	args: { userId: v.string(), dodoCustomerId: v.string() },
	returns: v.string(),
	handler: async (ctx, { userId, dodoCustomerId }) => {
		const user = await getUserBySubject(ctx.db, userId);

		if (!user) throw new Error(`No user record for ${userId}.`);

		if (user.dodoCustomerId) return user.dodoCustomerId;

		await ctx.db.patch('users', user._id, { dodoCustomerId });

		return dodoCustomerId;
	}
});
