import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';

type ExpiryFields = Pick<
	Doc<'subscriptions'>,
	| '_id'
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodEnd'
	| 'billingPeriodEnded'
	| 'billingPeriodCheckId'
>;

export async function scheduleSubscriptionExpiry(
	ctx: MutationCtx,
	subscription: ExpiryFields
): Promise<void> {
	const { dodoSubscriptionId, billingPeriodEnd, billingPeriodCheckId } = subscription;
	const managed = dodoSubscriptionId !== undefined && billingPeriodEnd !== undefined;
	const ended = managed && Date.now() >= billingPeriodEnd;
	const needsCheck = managed && subscription.status === 'active' && !ended;

	const check = billingPeriodCheckId
		? await ctx.db.system.get('_scheduled_functions', billingPeriodCheckId)
		: null;

	if (
		needsCheck &&
		check?.state.kind === 'pending' &&
		check.scheduledTime === billingPeriodEnd &&
		check.args[0]?.dodoSubscriptionId === dodoSubscriptionId
	) {
		return;
	}

	if (check?.state.kind === 'pending') await ctx.scheduler.cancel(check._id);

	const checkId = needsCheck
		? await ctx.scheduler.runAt(
				billingPeriodEnd,
				internal.subscriptionExpiry.checkSubscriptionExpiry,
				{
					subscriptionId: subscription._id,
					dodoSubscriptionId,
					billingPeriodEnd
				}
			)
		: undefined;

	if (subscription.billingPeriodEnded !== ended || billingPeriodCheckId !== checkId) {
		await ctx.db.patch('subscriptions', subscription._id, {
			billingPeriodEnded: ended,
			billingPeriodCheckId: checkId
		});
	}
}

export const checkSubscriptionExpiry = internalMutation({
	args: {
		subscriptionId: v.id('subscriptions'),
		dodoSubscriptionId: v.string(),
		billingPeriodEnd: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const subscription = await ctx.db.get('subscriptions', args.subscriptionId);

		if (
			!subscription ||
			subscription.dodoSubscriptionId !== args.dodoSubscriptionId ||
			subscription.billingPeriodEnd !== args.billingPeriodEnd ||
			Date.now() < args.billingPeriodEnd
		) {
			return null;
		}

		// Keep provider status and event ordering intact for delayed renewal webhooks.
		await ctx.db.patch('subscriptions', subscription._id, {
			billingPeriodEnded: true,
			billingPeriodCheckId: undefined
		});

		return null;
	}
});
