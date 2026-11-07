import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import { getUserBySubject } from '@convex/lib/auth';
import { RENEWAL_GRACE_MS } from '@convex/lib/tiers';
import { vSubscriptionStatus } from '@convex/lib/validators';

/** The customer's linked user, else the checkout's `userId` metadata, which links the customer. */
async function resolveOwner(
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

export const sync = internalMutation({
	args: {
		fetchedAt: v.number(),
		dodoCustomerId: v.string(),
		metadataUserId: v.optional(v.string()),
		subscription: v.object({
			dodoSubscriptionId: v.string(),
			dodoProductId: v.string(),
			status: vSubscriptionStatus,
			billingPeriodStart: v.number(),
			billingPeriodEnd: v.number(),
			cancelAtNextBillingDate: v.boolean()
		})
	},
	returns: v.null(),
	handler: async (ctx, { fetchedAt, dodoCustomerId, metadataUserId, subscription }) => {
		const existing = await ctx.db
			.query('subscriptions')
			.withIndex('by_dodoSubscriptionId', (query) =>
				query.eq('dodoSubscriptionId', subscription.dodoSubscriptionId)
			)
			.unique();

		if (existing && (existing.syncedAt ?? 0) > fetchedAt) return null;

		const userId = existing?.userId ?? (await resolveOwner(ctx, dodoCustomerId, metadataUserId));

		if (!userId) {
			console.error(
				`Dodo subscription ${subscription.dodoSubscriptionId} belongs to unknown customer ${dodoCustomerId}.`
			);

			return null;
		}

		const row = {
			...subscription,
			userId,
			syncedAt: fetchedAt,
			quotaResetAt: existing?.quotaResetAt
		};

		if (existing) await ctx.db.replace('subscriptions', existing._id, row);
		else await ctx.db.insert('subscriptions', row);

		return null;
	}
});

export const listOverdue = internalQuery({
	args: { now: v.number() },
	returns: v.array(v.string()),
	handler: async (ctx, { now }) => {
		const rows = await ctx.db
			.query('subscriptions')
			.withIndex('by_status_and_billingPeriodEnd', (query) =>
				query.eq('status', 'active').lt('billingPeriodEnd', now - RENEWAL_GRACE_MS)
			)
			.order('desc')
			.take(100);

		return rows.flatMap((row) => (row.dodoSubscriptionId ? [row.dodoSubscriptionId] : []));
	}
});
