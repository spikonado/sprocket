import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { computeAccess } from '@convex/lib/subscriptionProjection';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

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

function clearCreatedAt(_ctx: MutationCtx, doc: { createdAt?: number }) {
	return doc.createdAt === undefined ? undefined : { createdAt: undefined };
}

export const removeUsersCreatedAt = migrations.define({
	table: 'users',
	migrateOne: clearCreatedAt
});

export const removeMachinesCreatedAt = migrations.define({
	table: 'machines',
	migrateOne: clearCreatedAt
});

export const removeThreadUsageEventsCreatedAt = migrations.define({
	table: 'threadUsageEvents',
	migrateOne: clearCreatedAt
});

export const removeAgentQuestionsCreatedAt = migrations.define({
	table: 'agentQuestions',
	migrateOne: clearCreatedAt
});

export const removeArtifactsCreatedAt = migrations.define({
	table: 'artifacts',
	migrateOne: clearCreatedAt
});

export const removeMandatesCreatedAt = migrations.define({
	table: 'mandates',
	migrateOne: clearCreatedAt
});

export const removeMandateChargesCreatedAt = migrations.define({
	table: 'mandateCharges',
	migrateOne: clearCreatedAt
});

export const removeCreatedAt = migrations.runner([
	internal.migrations.removeUsersCreatedAt,
	internal.migrations.removeMachinesCreatedAt,
	internal.migrations.removeThreadUsageEventsCreatedAt,
	internal.migrations.removeAgentQuestionsCreatedAt,
	internal.migrations.removeArtifactsCreatedAt,
	internal.migrations.removeMandatesCreatedAt,
	internal.migrations.removeMandateChargesCreatedAt
]);

export const removeThreadRecordLegacyFields = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) =>
		thread.submissionId === undefined && thread.treeCancellation === undefined
			? undefined
			: { submissionId: undefined, treeCancellation: undefined }
});

export const runThreadRecordLegacyFieldsRemoval = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await migrations.runOne(ctx, internal.migrations.removeThreadRecordLegacyFields);

		return null;
	}
});

function clearUserId(_ctx: MutationCtx, doc: { userId?: string }) {
	return doc.userId === undefined ? undefined : { userId: undefined };
}

export const removeTranscriptStatesUserId = migrations.define({
	table: 'threadTranscriptStates',
	migrateOne: clearUserId
});

export const removeTranscriptPartsUserId = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: clearUserId
});

export const removeTranscriptUserId = migrations.runner([
	internal.migrations.removeTranscriptStatesUserId,
	internal.migrations.removeTranscriptPartsUserId
]);

export const moveMachineCredentialHashes = migrations.define({
	table: 'machines',
	migrateOne: (_ctx, machine) => {
		if (machine.credentialHash === undefined) return;

		return { processId: machine.processId ?? machine.credentialHash, credentialHash: undefined };
	}
});

export const runMachineProcessIdBackfill = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await migrations.runOne(ctx, internal.migrations.moveMachineCredentialHashes);

		return null;
	}
});
