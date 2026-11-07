import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';

export const migrations = new Migrations(components.migrations, { schema, internalMutation });

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

export const backfillSubscriptionAccess = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, subscription) => {
		if (subscription.accessPhase !== undefined) return;

		await scheduleSubscriptionExpiry(ctx, subscription);
	}
});

export const dropQuestionAnsweredAt = migrations.define({
	table: 'agentQuestions',
	migrateOne: (_ctx, question) => {
		if (question.answeredAt !== undefined) return { answeredAt: undefined };
	}
});

export const dropQuotaGenerations = migrations.define({
	table: 'subscriptions',
	migrateOne: (_ctx, subscription) => {
		if (
			subscription.quotaGeneration !== undefined ||
			subscription.quotaTransitionAt !== undefined
		) {
			return { quotaGeneration: undefined, quotaTransitionAt: undefined };
		}
	}
});

export const run = migrations.runner([
	internal.migrations.backfillToolInvocationIds,
	internal.migrations.removeArtifactTypes,
	internal.migrations.dropPricingCacheKeys,
	internal.migrations.countContextSummaryParts,
	internal.migrations.backfillSubscriptionAccess,
	internal.migrations.dropQuestionAnsweredAt,
	internal.migrations.dropQuotaGenerations
]);
