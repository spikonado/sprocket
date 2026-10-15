import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { isRunFinalStatus } from '@convex/lib/validators';
import { reconcileTerminalRun } from '@convex/lib/runTerminal';
import { computeAccess } from '@convex/lib/subscriptionProjection';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const reconcileLegacyTerminalJobs = migrations.define({
	table: 'runExecutionStates',
	batchSize: 1,
	migrateOne: async (ctx, state) => {
		if (state.terminalJobsReconciled !== undefined) return;
		const run = await ctx.db.get('runs', state.runId);

		if (!run || !isRunFinalStatus(run.status)) return;

		await reconcileTerminalRun(ctx, run, {
			completedAt: run.completedAt ?? Date.now(),
			jobCursor: -1,
			questionCursor: -1
		});
	}
});

export const runTerminalJobBackfill = migrations.runner([
	internal.migrations.reconcileLegacyTerminalJobs
]);

export const backfillSubscriptionExpiry = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, subscription) => {
		if (!subscription.dodoSubscriptionId) return;

		await scheduleSubscriptionExpiry(ctx, subscription);
	}
});

export const runSubscriptionExpiryBackfill = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await migrations.runOne(ctx, internal.migrations.backfillSubscriptionExpiry);

		return null;
	}
});

/**
 * Backfill access phase/deadline, projection revision, and payload watermark
 * for subscriptions written before those fields existed. Idempotent: rows
 * that already carry every field are skipped. Kept off the automatic hourly
 * run so an operator can verify a dry run first:
 *
 *   bunx convex run migrations:runSubscriptionAccessBackfill '{"dryRun":true}'
 *   bunx convex run migrations:runSubscriptionAccessBackfill
 */
export const backfillSubscriptionAccess = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, subscription) => {
		const hasRevision = subscription.projectionRevision !== undefined;
		const hasPayloadWatermark = subscription.payloadEventAt !== undefined;
		const hasAccess = subscription.accessPhase !== undefined;
		const hasGeneration = subscription.quotaGeneration !== undefined;

		if (
			hasRevision &&
			hasPayloadWatermark &&
			hasAccess &&
			hasGeneration &&
			subscription.scheduleEventAt !== undefined
		)
			return;

		// Long-expired terms must not gain fresh grace: clamp the backfilled
		// clock so a stale term never materializes a renewal-processing window.
		const now = Date.now();

		const access = computeAccess(
			{
				status: subscription.status,
				dodoSubscriptionId: subscription.dodoSubscriptionId,
				billingPeriodStart: subscription.billingPeriodStart,
				billingPeriodEnd: subscription.billingPeriodEnd,
				cancelAtNextBillingDate: subscription.cancelAtNextBillingDate
			},
			now
		);

		// Derive the monotonic usage generation from the legacy timestamp key:
		// bucket keys keep moving with the same value they already used, so the
		// migration itself neither resets usage nor mints extra allowance. The
		// legacy key is preserved only on rows that already carry it; a legacy
		// row without quotaResetAt never gains one, so its original
		// rate-limiter bucket key stays untouched.
		const quotaGeneration = subscription.quotaGeneration ?? subscription.quotaResetAt ?? 0;

		const patch = {
			projectionRevision: subscription.projectionRevision ?? 1,
			payloadEventAt: subscription.payloadEventAt ?? subscription.eventAt,
			termEventAt: subscription.termEventAt ?? subscription.eventAt,
			scheduleEventAt:
				subscription.scheduleEventAt ?? subscription.payloadEventAt ?? subscription.eventAt,
			providerStatus: subscription.providerStatus ?? subscription.status,
			accessPhase: subscription.accessPhase ?? access.accessPhase,
			accessEndsAt: subscription.accessEndsAt ?? access.accessEndsAt,
			quotaGeneration,
			quotaTransitionAt: subscription.quotaTransitionAt ?? subscription.quotaResetAt,
			quotaResetAt: subscription.quotaResetAt
		};

		await ctx.db.patch('subscriptions', subscription._id, patch);
		await scheduleSubscriptionExpiry(ctx, { ...subscription, ...patch });
	}
});

export const runSubscriptionAccessBackfill = internalMutation({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, { dryRun }) => {
		await migrations.runOne(ctx, internal.migrations.backfillSubscriptionAccess, {
			dryRun: dryRun ?? false
		});

		return null;
	}
});
