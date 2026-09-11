import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const runProductionRolloutCleanup = migrations.runner([
	internal.migrations.backfillMissingThreadStatus,
	internal.migrations.removeRunCompletionTransport,
	internal.migrations.removeThreadUsageLegacyFields,
	internal.migrations.removeExecutorJobCloudWorkPool
]);

export const backfillMissingThreadStatus = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		if (thread.status !== undefined) return;
		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', thread._id))
			.order('desc')
			.first();
		return { status: latestRun?.status ?? 'completed' };
	}
});

export const removeRunCompletionTransport = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.completionTransport === undefined) return;
		return { completionTransport: undefined };
	}
});

export const removeThreadUsageLegacyFields = migrations.define({
	table: 'threadUsage',
	migrateOne: (_ctx, usage) => {
		if (usage.totalTokensProcessed === undefined && usage.usageLedgerMigratedAt === undefined) {
			return;
		}
		return { totalTokensProcessed: undefined, usageLedgerMigratedAt: undefined };
	}
});

export const removeExecutorJobCloudWorkPool = migrations.define({
	table: 'executorJobs',
	migrateOne: (_ctx, job) => {
		if (job.cloudWorkPool === undefined) return;
		return { cloudWorkPool: undefined };
	}
});
