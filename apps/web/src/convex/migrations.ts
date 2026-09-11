import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';

export const AUTOMATIC_CLEANUP_DELAY_MS = 48 * 60 * 60 * 1_000;
const PRODUCTION_ROLLOUT_CLEANUP = 'production-rollout-cleanup-2026-09';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

const productionRolloutCleanupMigrations = [
	internal.migrations.backfillMissingThreadStatus,
	internal.migrations.removeRunCompletionTransport,
	internal.migrations.removeThreadUsageLegacyFields,
	internal.migrations.removeExecutorJobCloudWorkPool
];

export const runProductionRolloutCleanup = migrations.runner(productionRolloutCleanupMigrations);

export const runProductionRolloutCleanupAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const schedule = await ctx.db
			.query('migrationSchedules')
			.withIndex('by_name', (query) => query.eq('name', PRODUCTION_ROLLOUT_CLEANUP))
			.unique();
		if (!schedule) {
			await ctx.db.insert('migrationSchedules', {
				name: PRODUCTION_ROLLOUT_CLEANUP,
				notBefore: now + AUTOMATIC_CLEANUP_DELAY_MS
			});
			return null;
		}
		if (schedule.completedAt !== undefined || now < schedule.notBefore) return null;

		const statuses = await migrations.getStatus(ctx, {
			migrations: productionRolloutCleanupMigrations
		});
		if (statuses.every((status) => status.isDone)) {
			await ctx.db.patch('migrationSchedules', schedule._id, { completedAt: now });
			return null;
		}

		if (schedule.startedAt === undefined) {
			await ctx.db.patch('migrationSchedules', schedule._id, { startedAt: now });
		}
		await migrations.runSerially(ctx, productionRolloutCleanupMigrations);
		return null;
	}
});

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
