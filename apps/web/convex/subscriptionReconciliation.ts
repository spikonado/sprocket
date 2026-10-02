import { v } from 'convex/values';
import { Workpool, vOnCompleteArgs } from '@convex-dev/workpool';
import { components, internal } from '@convex/_generated/api';
import { internalAction, internalMutation, internalQuery } from '@convex/_generated/server';
import { z } from 'zod';
import { classifyBillingInterval } from '@convex/lib/dodoProducts';
import { applyDodoSubscriptionProjection } from '@convex/billing';

const MAX_ATTEMPTS = 4;

const MAX_RECOVERY_ATTEMPTS = 12;

const BASE_BACKOFF_MS = 30 * 1_000;

const MAX_BACKOFF_MS = 5 * 60 * 1_000;

const reconciliationWorkpool = new Workpool(components.billingReconciliationWorkpool, {
	maxParallelism: 4
});

const vObservationOutcome = v.union(
	v.literal('applied'),
	v.literal('stale'),
	v.literal('duplicate'),
	v.literal('noop'),
	v.literal('competing'),
	v.literal('unresolved')
);

const vReconcileOutcome = v.object({
	outcome: v.union(
		v.literal('observed'),
		v.literal('blocked'),
		v.literal('deferred'),
		v.literal('skipped'),
		v.literal('failed')
	),
	detail: v.optional(v.string())
});

export const queueReconciliation = internalMutation({
	args: {
		subscriptionId: v.id('subscriptions'),
		dodoSubscriptionId: v.string(),
		projectionRevision: v.number(),
		// A forced retrieval runs even outside the access phases that normally
		// gate reconciliation.
		force: v.optional(v.boolean()),
		replay: v.optional(v.boolean()),
		attempt: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const subscription = await ctx.db.get('subscriptions', args.subscriptionId);

		if (
			!subscription ||
			subscription.dodoSubscriptionId !== args.dodoSubscriptionId ||
			(subscription.projectionRevision ?? 0) !== args.projectionRevision
		)
			return null;

		const current = await ctx.db
			.query('subscriptionReconciliations')
			.withIndex('by_subscriptionId', (q) => q.eq('subscriptionId', args.subscriptionId))
			.unique();

		const attempt = args.attempt ?? 0;

		if (!args.replay && current?.dodoSubscriptionId === args.dodoSubscriptionId) {
			if (
				current.projectionRevision === args.projectionRevision &&
				current.state === 'pending' &&
				attempt <= current.attempt
			)
				return null;

			if (
				current.projectionRevision === args.projectionRevision &&
				current.accessPhase === (subscription.accessPhase ?? 'none') &&
				current.state !== 'pending' &&
				(!args.force || current.updatedAt > Date.now() - 60_000)
			)
				return null;
		}

		const workId = await reconciliationWorkpool.enqueueAction(
			ctx,
			internal.subscriptionReconciliation.reconcileSubscription,
			{
				subscriptionId: args.subscriptionId,
				dodoSubscriptionId: args.dodoSubscriptionId,
				projectionRevision: args.projectionRevision,
				force: args.force,
				attempt: args.attempt
			},
			{
				retry: false,
				runAfter: attempt > 0 ? backoffMs(attempt - 1) : 0,
				onComplete: internal.subscriptionReconciliation.completeReconciliation,
				context: { subscriptionId: args.subscriptionId }
			}
		);

		const record = {
			subscriptionId: args.subscriptionId,
			dodoSubscriptionId: args.dodoSubscriptionId,
			accessPhase: subscription.accessPhase ?? 'none',
			projectionRevision: args.projectionRevision,
			attempt,
			workId,
			state: 'pending' as const,
			updatedAt: Date.now()
		};

		if (current) await ctx.db.replace('subscriptionReconciliations', current._id, record);
		else await ctx.db.insert('subscriptionReconciliations', record);

		return null;
	}
});

export const completeReconciliation = internalMutation({
	args: vOnCompleteArgs(v.object({ subscriptionId: v.id('subscriptions') }), vReconcileOutcome),
	returns: v.null(),
	handler: async (ctx, { context, workId, result }) => {
		const record = await ctx.db
			.query('subscriptionReconciliations')
			.withIndex('by_subscriptionId', (q) => q.eq('subscriptionId', context.subscriptionId))
			.unique();

		if (!record || record.workId !== workId || record.state !== 'pending') return null;

		const subscription = await ctx.db.get('subscriptions', context.subscriptionId);

		const completed =
			result.kind === 'success' &&
			(result.returnValue.outcome === 'skipped' ||
				(result.returnValue.outcome === 'observed' &&
					(subscription?.dodoSubscriptionId !== record.dodoSubscriptionId ||
						subscription.terminalConfirmed === true ||
						subscription.accessPhase === 'paid')));

		await ctx.db.patch('subscriptionReconciliations', record._id, {
			state: completed ? 'completed' : 'exhausted',
			updatedAt: Date.now()
		});

		return null;
	}
});

export const getReconciliation = internalQuery({
	args: { subscriptionId: v.id('subscriptions') },
	handler: async (ctx, { subscriptionId }) =>
		await ctx.db
			.query('subscriptionReconciliations')
			.withIndex('by_subscriptionId', (q) => q.eq('subscriptionId', subscriptionId))
			.unique()
});

const retrievedSchema = z.object({
	subscriptionId: z.string(),
	productId: z.string(),
	status: z.enum([
		'active',
		'on_hold',
		'cancelled',
		'expired',
		'failed',
		'past_due',
		'paused',
		'pending'
	]),
	previousBillingDate: z.string(),
	nextBillingDate: z.string(),
	cancelAtNextBillingDate: z.boolean(),
	paymentFrequencyCount: z.number(),
	paymentFrequencyInterval: z.string(),
	customerId: z.string(),
	metadata: z.record(z.string(), z.string()),
	scheduledChange: z
		.object({ id: z.string(), productId: z.string(), effectiveAt: z.string() })
		.nullable()
});

function backoffMs(attempt: number): number {
	const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);

	return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

type ReconcileOutcome = {
	outcome: 'observed' | 'blocked' | 'deferred' | 'skipped' | 'failed';
	detail?: string;
};

/**
 * Observe authoritative provider state for a subscription and apply it as an
 * observation, not a synthetic event. Fenced by the projection revision
 * captured before retrieval so a webhook or operator action that advanced
 * the projection during the fetch is never overwritten by a stale result.
 * Observations use the provider payload's own billing dates and never stamp
 * a synthetic webhook time, so the projection watermarks keep a delayed
 * legitimate webhook from being suppressed.
 */
export const reconcileSubscription = internalAction({
	args: {
		subscriptionId: v.id('subscriptions'),
		dodoSubscriptionId: v.string(),
		projectionRevision: v.number(),
		force: v.optional(v.boolean()),
		attempt: v.optional(v.number())
	},
	returns: vReconcileOutcome,
	handler: async (ctx, args): Promise<ReconcileOutcome> => {
		const attempt = args.attempt ?? 0;

		const before = await ctx.runQuery(internal.subscriptionExpiry.getSubscriptionAccess, {
			dodoSubscriptionId: args.dodoSubscriptionId
		});

		if (
			!before ||
			before.projectionRevision !== args.projectionRevision ||
			before.subscriptionId !== args.subscriptionId
		) {
			return { outcome: 'skipped', detail: 'Subscription moved past this reconciliation.' };
		}

		// Renewal polling runs during grace; recovery polling continues after
		// access ended as long as the subscription is not provider-terminal.
		// Neither grants access; portal repair stays the customer path.
		const inGrace = before.accessPhase === 'renewal_processing';
		const recoverable = before.terminalConfirmed !== true;

		if (!args.force && !inGrace && !(before.accessPhase === 'none' && recoverable))
			return { outcome: 'skipped', detail: 'Subscription is not in a reconcilable phase.' };

		if (!inGrace && !args.force && attempt >= MAX_RECOVERY_ATTEMPTS)
			return { outcome: 'failed', detail: 'Recovery reconciliation exhausted its attempts.' };

		const attemptLimit = inGrace ? MAX_ATTEMPTS : MAX_RECOVERY_ATTEMPTS;

		let retrieved: z.infer<typeof retrievedSchema>;

		try {
			const raw = await ctx.runAction(internal.pricing.retrieveSubscription, {
				dodoSubscriptionId: args.dodoSubscriptionId
			});

			retrieved = retrievedSchema.parse(raw);
		} catch {
			if (attempt + 1 >= attemptLimit) {
				console.error('Reconciliation retrieval exhausted retries; operator recovery required.');

				return { outcome: 'failed', detail: 'Provider retrieval exhausted its attempts.' };
			}

			await ctx.runMutation(internal.subscriptionReconciliation.queueReconciliation, {
				...args,
				attempt: attempt + 1
			});

			return { outcome: 'deferred', detail: 'Retrieval failed; retry scheduled.' };
		}

		const interval = classifyBillingInterval(
			retrieved.paymentFrequencyCount,
			retrieved.paymentFrequencyInterval
		);

		if (!interval) {
			const detail = `Reconciliation observed an unsupported interval on ${args.dodoSubscriptionId}.`;

			console.error(detail);

			return { outcome: 'failed', detail };
		}

		const status = retrieved.status;

		if (status === 'paused' || status === 'pending') {
			const detail = `Reconciliation observed unsupported status "${status}" on ${args.dodoSubscriptionId}.`;

			console.error(detail);

			return { outcome: 'failed', detail };
		}

		const previousBillingDate = Date.parse(retrieved.previousBillingDate);
		const nextBillingDate = Date.parse(retrieved.nextBillingDate);

		if (
			!Number.isFinite(previousBillingDate) ||
			!Number.isFinite(nextBillingDate) ||
			nextBillingDate <= previousBillingDate
		) {
			const detail = `Reconciliation observed invalid billing dates on ${args.dodoSubscriptionId}.`;

			console.error(detail);

			return { outcome: 'failed', detail };
		}

		const observedAt = Date.now();

		const result = await ctx.runMutation(internal.subscriptionReconciliation.applyObservation, {
			userId: retrieved.metadata.userId,
			tier: retrieved.metadata.tierId,
			checkoutAttemptId: retrieved.metadata.checkoutAttemptId,
			subscriptionId: args.subscriptionId,
			expectedProjectionRevision: args.projectionRevision,
			dodoSubscriptionId: retrieved.subscriptionId,
			dodoProductId: retrieved.productId,
			dodoCustomerId: retrieved.customerId,
			status,
			// Billing-period provenance only; ordering uses observedAt.
			eventAt: previousBillingDate,
			observedAt,
			billingInterval: interval,
			billingPeriodStart: previousBillingDate,
			billingPeriodEnd: nextBillingDate,
			cancelAtNextBillingDate: retrieved.cancelAtNextBillingDate,
			scheduledChange: retrieved.scheduledChange
				? {
						id: retrieved.scheduledChange.id,
						productId: retrieved.scheduledChange.productId,
						effectiveAt: Date.parse(retrieved.scheduledChange.effectiveAt)
					}
				: null
		});

		if (result.outcome === 'competing')
			return { outcome: 'blocked', detail: result.detail ?? 'Competing subscription preserved.' };

		if (result.outcome === 'unresolved')
			return { outcome: 'blocked', detail: result.detail ?? 'Observation unresolved.' };

		if (result.outcome === 'stale')
			return { outcome: 'skipped', detail: result.detail ?? 'Observation superseded.' };

		// Reconciliation is unresolved until the provider projects access; a
		// converged duplicate/noop means the subscription shows paid or
		// terminal now.
		const stillCurrent = await ctx.runQuery(internal.subscriptionExpiry.getSubscriptionAccess, {
			dodoSubscriptionId: args.dodoSubscriptionId
		});

		if (
			!stillCurrent ||
			stillCurrent.subscriptionId !== args.subscriptionId ||
			stillCurrent.terminalConfirmed ||
			stillCurrent.accessPhase === 'paid'
		) {
			return { outcome: 'observed' };
		}

		// Forced single-shot retrievals never chain; grace/recovery polling
		// chains and stops at access, termination, or the attempt bound.
		if (args.force) return { outcome: 'observed' };

		if (attempt + 1 >= attemptLimit)
			return { outcome: 'failed', detail: 'Reconciliation exhausted its attempts.' };

		await ctx.runMutation(internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: args.subscriptionId,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: stillCurrent.projectionRevision,
			attempt: attempt + 1
		});

		return { outcome: 'deferred', detail: 'Renewal unconfirmed; polling continues.' };
	}
});

/**
 * Re-fences on the projection revision captured before the provider fetch,
 * then applies the observation through the ordinary projection path.
 * All-or-nothing with the projection write.
 */
export const applyObservation = internalMutation({
	args: {
		userId: v.optional(v.string()),
		tier: v.optional(v.string()),
		checkoutAttemptId: v.optional(v.string()),
		subscriptionId: v.id('subscriptions'),
		expectedProjectionRevision: v.number(),
		dodoSubscriptionId: v.string(),
		dodoProductId: v.string(),
		dodoCustomerId: v.string(),
		status: v.union(
			v.literal('active'),
			v.literal('on_hold'),
			v.literal('cancelled'),
			v.literal('expired'),
			v.literal('failed'),
			v.literal('past_due')
		),
		eventAt: v.number(),
		observedAt: v.number(),
		billingInterval: v.union(v.literal('monthly'), v.literal('annual')),
		billingPeriodStart: v.number(),
		billingPeriodEnd: v.number(),
		cancelAtNextBillingDate: v.boolean(),
		scheduledChange: v.optional(
			v.union(
				v.object({ id: v.string(), productId: v.string(), effectiveAt: v.number() }),
				v.null()
			)
		)
	},
	returns: v.object({
		outcome: vObservationOutcome,
		detail: v.optional(v.string())
	}),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get('subscriptions', args.subscriptionId);

		if (
			!existing ||
			existing.dodoSubscriptionId !== args.dodoSubscriptionId ||
			(existing.projectionRevision ?? 0) !== args.expectedProjectionRevision
		) {
			return {
				outcome: 'stale' as const,
				detail: 'Projection revision advanced during retrieval.'
			};
		}

		return await applyDodoSubscriptionProjection(ctx, args);
	}
});
