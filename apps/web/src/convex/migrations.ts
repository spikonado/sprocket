import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { patchInboxThread } from './lib/inbox';

export const AUTOMATIC_CLEANUP_DELAY_MS = 48 * 60 * 60 * 1_000;
const PRODUCTION_ROLLOUT_CLEANUP = 'production-rollout-cleanup-2026-09';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const backfillInbox = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		if (thread.inboxState !== undefined) return;
		await patchInboxThread(ctx, thread, {});
	}
});

export const runInboxMigration = migrations.runner([internal.migrations.backfillInbox]);

export const runInboxMigrationAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const steps = [internal.migrations.backfillInbox];
		const statuses = await migrations.getStatus(ctx, { migrations: steps });
		if (!statuses.every((status) => status.isDone)) await migrations.runSerially(ctx, steps);
		return null;
	}
});

const productionRolloutCleanupMigrations = [
	internal.migrations.backfillMissingThreadStatus,
	internal.migrations.removeThreadRecordProjectId,
	internal.migrations.removeRunCompletionTransport,
	internal.migrations.removeRunLegacyFields,
	internal.migrations.removeThreadUsageLegacyFields,
	internal.migrations.removeTranscriptStateMigratedAt,
	internal.migrations.removeImageUploadMessageIds,
	internal.migrations.removeExecutorJobCloudWorkPool,
	internal.migrations.removeExecutorJobProjectId,
	internal.migrations.deleteProjectConnections,
	internal.migrations.deleteProjects
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
		const status = latestRun?.status ?? 'completed';
		await patchInboxThread(ctx, thread, {
			status: status === 'awaiting_executor' ? 'running' : status,
			lastCompletedAt: latestRun?.completedAt
		});
	}
});

export const removeRunCompletionTransport = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.completionTransport === undefined) return;
		return { completionTransport: undefined };
	}
});

export const removeThreadRecordProjectId = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.projectId === undefined) return;
		return { projectId: undefined };
	}
});

export const removeRunLegacyFields = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (
			run.projectId === undefined &&
			run.catalogVersion === undefined &&
			run.contextWindowTokens === undefined &&
			run.autoCompactTokenLimit === undefined &&
			run.promptMessageId === undefined
		) {
			return;
		}
		return {
			projectId: undefined,
			catalogVersion: undefined,
			contextWindowTokens: undefined,
			autoCompactTokenLimit: undefined,
			promptMessageId: undefined
		};
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

export const removeTranscriptStateMigratedAt = migrations.define({
	table: 'threadTranscriptStates',
	migrateOne: (_ctx, state) => {
		if (state.migratedAt === undefined) return;
		return { migratedAt: undefined };
	}
});

export const removeImageUploadMessageIds = migrations.define({
	table: 'imageUploads',
	migrateOne: (_ctx, upload) => {
		if (upload.messageIds === undefined) return;
		return { messageIds: undefined };
	}
});

export const removeExecutorJobCloudWorkPool = migrations.define({
	table: 'executorJobs',
	migrateOne: (_ctx, job) => {
		if (job.cloudWorkPool === undefined) return;
		return { cloudWorkPool: undefined };
	}
});

export const removeExecutorJobProjectId = migrations.define({
	table: 'executorJobs',
	migrateOne: (_ctx, job) => {
		if (job.projectId === undefined) return;
		return { projectId: undefined };
	}
});

export const deleteProjectConnections = migrations.define({
	table: 'projectConnections',
	migrateOne: async (ctx, connection) => {
		await ctx.db.delete('projectConnections', connection._id);
	}
});

export const deleteProjects = migrations.define({
	table: 'projects',
	migrateOne: async (ctx, project) => {
		await ctx.db.delete('projects', project._id);
	}
});
