import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import type { MutationCtx } from '@convex/_generated/server';
import type { TableNames } from '@convex/_generated/dataModel';
import { getUserBySubject } from '@convex/lib/auth';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, { schema, internalMutation });

// Spreads the resync's Dodo list calls so up to ~14k customers stay under Dodo's 240 requests a minute.
const DODO_RESYNC_SPREAD_MS = 60 * 60 * 1_000;

/** Keeps the legacy pick: the latest grant wins and `active` breaks ties, so a later revoke holds. */
async function moveGrants(ctx: MutationCtx, userId: string): Promise<void> {
	const rows = await ctx.db
		.query('subscriptions')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();

	const grants = rows.filter((row) => !row.dodoSubscriptionId && row.tier && row.tier !== 'free');

	// An earlier row in the same batch already moved this user's grants.
	if (grants.length === 0) return;

	const winner = grants.reduce((best, row) => {
		const [rowAt, bestAt] = [row.eventAt ?? 0, best.eventAt ?? 0];

		return rowAt > bestAt || (rowAt === bestAt && row.status === 'active') ? row : best;
	});

	if (winner.status === 'active') {
		const user = await getUserBySubject(ctx.db, userId);

		if (!user) {
			console.error(`Tier grant ${winner._id} has no users row; leaving it in place.`);

			return;
		}

		await ctx.db.patch('users', user._id, { grantedTier: user.grantedTier ?? winner.tier });
	}

	for (const grant of grants) await ctx.db.delete('subscriptions', grant._id);
}

function deleteEveryRow(table: TableNames) {
	return migrations.define({
		table,
		migrateOne: async (ctx, row) => {
			await ctx.db.delete(table, row._id);
		}
	});
}

export const backfillToolInvocationIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		if (!part.tool || part.tool.toolInvocationId !== undefined) return;

		return { tool: { ...part.tool, toolInvocationId: part.sourceKey } };
	}
});

export const removeArtifactTypes = migrations.define({
	table: 'artifacts',
	migrateOne: (_ctx, artifact) => {
		if (artifact.type === undefined) return;

		return { type: undefined };
	}
});

export const countContextSummaryParts = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.contextSummaryThroughPartNumber === undefined) return;

		return {
			contextSummaryPartCount: thread.contextSummaryThroughPartNumber + 1,
			contextSummaryThroughPartNumber: undefined
		};
	}
});

export const dropQuestionAnsweredAt = migrations.define({
	table: 'agentQuestions',
	migrateOne: (_ctx, question) => {
		if (question.answeredAt !== undefined) return { answeredAt: undefined };
	}
});

/** Moves operator grants to `users.grantedTier`, deletes free bootstrap rows, and strips projection fields. */
export const migrateSubscriptionRows = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, row) => {
		if (row.billingPeriodCheckId) {
			const check = await ctx.db.system.get('_scheduled_functions', row.billingPeriodCheckId);

			if (check?.state.kind === 'pending') await ctx.scheduler.cancel(check._id);
		}

		if (!row.dodoSubscriptionId) {
			if (row.tier && row.tier !== 'free') await moveGrants(ctx, row.userId);
			else await ctx.db.delete('subscriptions', row._id);

			return;
		}

		if (row.syncedAt !== undefined) return;

		await ctx.db.replace('subscriptions', row._id, {
			userId: row.userId,
			dodoSubscriptionId: row.dodoSubscriptionId,
			dodoProductId: row.dodoProductId,
			status: row.status,
			billingPeriodStart: row.billingPeriodStart,
			billingPeriodEnd: row.billingPeriodEnd,
			cancelAtNextBillingDate: row.cancelAtNextBillingDate,
			quotaResetAt: row.quotaResetAt,
			syncedAt: 0
		});
	}
});

export const clearSubscriptionReconciliations = deleteEveryRow('subscriptionReconciliations');

export const clearSupersededSubscriptions = deleteEveryRow('supersededSubscriptions');

export const clearCheckoutSessions = deleteEveryRow('billingCheckoutSessions');

export const clearCheckoutAttempts = deleteEveryRow('billingCheckoutAttempts');

export const clearPricingCache = deleteEveryRow('dodoPricingCache');

/** Mirrors every Dodo subscription, including duplicates the old webhook rejected. */
export const resyncDodoCustomers = migrations.define({
	table: 'users',
	customRange: (query) =>
		query.withIndex('by_dodoCustomerId', (index) => index.gte('dodoCustomerId', '')),
	migrateOne: async (ctx, user) => {
		if (!user.dodoCustomerId) return;

		await ctx.scheduler.runAfter(
			Math.floor(Math.random() * DODO_RESYNC_SPREAD_MS),
			internal.dodo.syncCustomer,
			{ dodoCustomerId: user.dodoCustomerId }
		);
	}
});

export const backfillThreadCompletionProviders = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.completionProvider === undefined)
			return { completionProvider: 'spikonado' as const };
	}
});

export const backfillRunCompletionProviders = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.completionProvider === undefined) return { completionProvider: 'spikonado' as const };
	}
});

export const run = migrations.runner([
	internal.migrations.backfillToolInvocationIds,
	internal.migrations.removeArtifactTypes,
	internal.migrations.countContextSummaryParts,
	internal.migrations.dropQuestionAnsweredAt,
	internal.migrations.migrateSubscriptionRows,
	internal.migrations.clearSubscriptionReconciliations,
	internal.migrations.clearSupersededSubscriptions,
	internal.migrations.clearCheckoutSessions,
	internal.migrations.clearCheckoutAttempts,
	internal.migrations.clearPricingCache,
	internal.migrations.resyncDodoCustomers,
	internal.migrations.backfillThreadCompletionProviders,
	internal.migrations.backfillRunCompletionProviders
]);
