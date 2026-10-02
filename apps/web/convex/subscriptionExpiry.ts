import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import { computeAccess } from '@convex/lib/subscriptionProjection';

type ExpiryFields = Pick<
	Doc<'subscriptions'>,
	| '_id'
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'billingPeriodEnded'
	| 'billingPeriodCheckId'
	| 'accessPhase'
	| 'accessEndsAt'
	| 'projectionRevision'
	| 'cancelAtNextBillingDate'
>;

function accessTarget(subscription: ExpiryFields, now: number) {
	return computeAccess(
		{
			status: subscription.status,
			dodoSubscriptionId: subscription.dodoSubscriptionId,
			billingPeriodStart: subscription.billingPeriodStart,
			billingPeriodEnd: subscription.billingPeriodEnd,
			cancelAtNextBillingDate: subscription.cancelAtNextBillingDate
		},
		now
	);
}

/**
 * Materialize the access phase and schedule the boundary check that advances
 * it. Safe to call after every projection change; obsolete scheduled checks
 * are cancelled, and an already-correct pending check is kept.
 */
export async function scheduleSubscriptionExpiry(
	ctx: MutationCtx,
	subscription: ExpiryFields
): Promise<void> {
	const now = Date.now();
	const { dodoSubscriptionId, billingPeriodCheckId } = subscription;
	const managed = dodoSubscriptionId !== undefined && subscription.billingPeriodEnd !== undefined;

	const target = accessTarget(subscription, now);

	const currentPhase =
		subscription.accessPhase ?? (subscription.billingPeriodEnded ? 'none' : 'paid');

	const phaseCurrent = currentPhase === target.accessPhase;

	const endsAtCurrent =
		(subscription.accessEndsAt ?? undefined) === (target.accessEndsAt ?? undefined);

	// Every future boundary (term start, term end, grace end) keeps a pending
	// check so the materialized phase advances even when the current phase
	// grants no access (e.g. a confirmed term that starts in the future).
	const needsCheck =
		managed &&
		subscription.status === 'active' &&
		target.accessEndsAt !== undefined &&
		target.accessEndsAt > now;

	const check = billingPeriodCheckId
		? await ctx.db.system.get('_scheduled_functions', billingPeriodCheckId)
		: null;

	if (
		needsCheck &&
		check?.state.kind === 'pending' &&
		check.scheduledTime === target.accessEndsAt &&
		check.args[0]?.dodoSubscriptionId === dodoSubscriptionId &&
		check.args[0]?.projectionRevision === (subscription.projectionRevision ?? 0)
	) {
		// Correct fence and time already pending; only repair materialized
		// fields if they drifted.
		if (!phaseCurrent || !endsAtCurrent) {
			await ctx.db.patch('subscriptions', subscription._id, {
				accessPhase: target.accessPhase,
				accessEndsAt: target.accessEndsAt,
				billingPeriodEnded: target.accessPhase !== 'paid'
			});
		}

		return;
	}

	if (check?.state.kind === 'pending') await ctx.scheduler.cancel(check._id);

	const checkId = needsCheck
		? await ctx.scheduler.runAt(
				target.accessEndsAt!,
				internal.subscriptionExpiry.checkSubscriptionExpiry,
				{
					subscriptionId: subscription._id,
					dodoSubscriptionId,
					billingPeriodEnd: subscription.billingPeriodEnd!,
					projectionRevision: subscription.projectionRevision ?? 0,
					expectedPhase: target.accessPhase
				}
			)
		: undefined;

	await ctx.db.patch('subscriptions', subscription._id, {
		accessPhase: target.accessPhase,
		accessEndsAt: target.accessEndsAt,
		billingPeriodEnded: target.accessPhase !== 'paid',
		billingPeriodCheckId: checkId
	});
}

/**
 * Advance the access phase at a scheduled boundary. Fenced by subscription
 * id + provider subscription id + projection revision, so stale checks for
 * superseded terms or subscriptions are no-ops. Entering renewal-processing
 * grace kicks off provider reconciliation; grace exhaustion ends access.
 * Every transition that still has a future boundary chains the next check,
 * so a term that starts in the future advances at its end too.
 */
export const checkSubscriptionExpiry = internalMutation({
	args: {
		subscriptionId: v.id('subscriptions'),
		dodoSubscriptionId: v.string(),
		billingPeriodEnd: v.number(),
		projectionRevision: v.optional(v.number()),
		expectedPhase: v.optional(
			v.union(v.literal('paid'), v.literal('renewal_processing'), v.literal('none'))
		)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const subscription = await ctx.db.get('subscriptions', args.subscriptionId);

		if (
			!subscription ||
			subscription.dodoSubscriptionId !== args.dodoSubscriptionId ||
			subscription.billingPeriodEnd !== args.billingPeriodEnd ||
			(subscription.projectionRevision ?? 0) !== (args.projectionRevision ?? 0) ||
			(args.expectedPhase !== undefined && subscription.accessPhase !== args.expectedPhase)
		) {
			return null;
		}

		const target = accessTarget(subscription, now);

		if (
			subscription.accessPhase === target.accessPhase &&
			target.accessEndsAt === subscription.accessEndsAt
		) {
			return null;
		}

		await ctx.db.patch('subscriptions', subscription._id, {
			accessPhase: target.accessPhase,
			accessEndsAt: target.accessEndsAt,
			billingPeriodEnded: target.accessPhase !== 'paid',
			billingPeriodCheckId: undefined
		});

		// A still-active subscription with a future boundary (a paid term
		// that just opened at its start, or renewal-processing grace with a
		// grace deadline) chains the next boundary check. Without this a
		// term confirmed before its start would open paid access at its
		// start but never advance at its end.
		const nextBoundary =
			subscription.status === 'active' &&
			target.accessEndsAt !== undefined &&
			target.accessEndsAt > now
				? target.accessEndsAt
				: undefined;

		if (target.accessPhase === 'renewal_processing' && target.accessEndsAt !== undefined) {
			// Observe authoritative provider state during grace; bounded by the
			// reconciler's own retry policy and stopped at grace exhaustion.
			await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
				subscriptionId: subscription._id,
				dodoSubscriptionId: args.dodoSubscriptionId,
				projectionRevision: subscription.projectionRevision ?? 0
			});
		}

		if (nextBoundary !== undefined) {
			const checkId = await ctx.scheduler.runAt(
				nextBoundary,
				internal.subscriptionExpiry.checkSubscriptionExpiry,
				{
					subscriptionId: subscription._id,
					dodoSubscriptionId: args.dodoSubscriptionId,
					billingPeriodEnd: args.billingPeriodEnd,
					projectionRevision: subscription.projectionRevision ?? 0,
					expectedPhase: target.accessPhase
				}
			);

			await ctx.db.patch('subscriptions', subscription._id, { billingPeriodCheckId: checkId });
		}

		if (target.accessPhase === 'none' && subscription.terminalConfirmed !== true) {
			// Grace exhausted without a provider confirmation: access stays ended,
			// and bounded recovery reconciliation keeps observing provider state
			// so a later repair/cancellation is detected. It never grants access
			// and never marks the subscription terminal; only a provider
			// cancelled/expired event does.
			await ctx.scheduler.runAfter(0, internal.subscriptionReconciliation.queueReconciliation, {
				subscriptionId: subscription._id,
				dodoSubscriptionId: args.dodoSubscriptionId,
				projectionRevision: subscription.projectionRevision ?? 0
			});
		}

		return null;
	}
});

/** Ledger of subscription access state for operational lookups. */
export const getSubscriptionAccess = internalQuery({
	args: { dodoSubscriptionId: v.string() },
	returns: v.union(
		v.object({
			subscriptionId: v.id('subscriptions'),
			userId: v.string(),
			tier: v.string(),
			status: v.string(),
			accessPhase: v.union(v.literal('paid'), v.literal('renewal_processing'), v.literal('none')),
			accessEndsAt: v.optional(v.number()),
			terminalConfirmed: v.boolean(),
			projectionRevision: v.number()
		}),
		v.null()
	),
	handler: async (ctx, { dodoSubscriptionId }) => {
		const match = await ctx.db
			.query('subscriptions')
			.withIndex('by_dodoSubscriptionId', (query) =>
				query.eq('dodoSubscriptionId', dodoSubscriptionId)
			)
			.unique();

		if (!match) return null;

		return {
			subscriptionId: match._id,
			userId: match.userId,
			tier: match.tier,
			status: match.status,
			accessPhase: match.accessPhase ?? (match.billingPeriodEnded ? 'none' : 'paid'),
			accessEndsAt: match.accessEndsAt,
			terminalConfirmed: match.terminalConfirmed === true,
			projectionRevision: match.projectionRevision ?? 0
		};
	}
});
