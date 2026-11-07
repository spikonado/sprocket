import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import { getUserBySubject } from '@convex/lib/auth';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, { schema, internalMutation });

// Spreads the resync's Dodo list calls so up to ~14k customers stay under Dodo's 240 requests a minute.
const DODO_RESYNC_SPREAD_MS = 60 * 60 * 1_000;

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

export const dropPricingCacheKeys = migrations.define({
	table: 'dodoPricingCache',
	migrateOne: (_ctx, row) => {
		if (row.cacheKey !== undefined) return { cacheKey: undefined };
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
			if (row.status === 'active' && row.tier && row.tier !== 'free') {
				const user = await getUserBySubject(ctx.db, row.userId);

				if (!user) {
					console.error(`Tier grant ${row._id} has no users row; leaving it in place.`);

					return;
				}

				await ctx.db.patch('users', user._id, { grantedTier: user.grantedTier ?? row.tier });
			}

			await ctx.db.delete('subscriptions', row._id);

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

export const clearSubscriptionReconciliations = migrations.define({
	table: 'subscriptionReconciliations',
	migrateOne: async (ctx, row) => {
		await ctx.db.delete('subscriptionReconciliations', row._id);
	}
});

export const clearSupersededSubscriptions = migrations.define({
	table: 'supersededSubscriptions',
	migrateOne: async (ctx, row) => {
		await ctx.db.delete('supersededSubscriptions', row._id);
	}
});

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

export const run = migrations.runner([
	internal.migrations.backfillToolInvocationIds,
	internal.migrations.removeArtifactTypes,
	internal.migrations.dropPricingCacheKeys,
	internal.migrations.countContextSummaryParts,
	internal.migrations.dropQuestionAnsweredAt,
	internal.migrations.migrateSubscriptionRows,
	internal.migrations.clearSubscriptionReconciliations,
	internal.migrations.clearSupersededSubscriptions,
	internal.migrations.resyncDodoCustomers
]);
