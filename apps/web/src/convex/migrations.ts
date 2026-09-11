import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { migrateRunExecution } from '@convex/lib/runExecution';
import { startRunLifecycle } from '@convex/runLifecycle';

export const AUTOMATIC_CLEANUP_DELAY_MS = 48 * 60 * 60 * 1_000;
const PRODUCTION_ROLLOUT_CLEANUP = 'production-rollout-cleanup-2026-09';
const FAST_MODE_BACKFILL = 'fast-mode-backfill-2026-09';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

const nativeRunLifecycleMigrations = [internal.migrations.migrateRunLifecycle];

export const runNativeRunLifecycleMigration = migrations.runner(nativeRunLifecycleMigrations);

export const runNativeRunLifecycleMigrationAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const statuses = await migrations.getStatus(ctx, { migrations: nativeRunLifecycleMigrations });
		if (!statuses.every((status) => status.isDone)) {
			await migrations.runSerially(ctx, nativeRunLifecycleMigrations);
		}
		return null;
	}
});

export const migrateRunLifecycle = migrations.define({
	table: 'runs',
	migrateOne: async (ctx, run) => {
		await startRunLifecycle(ctx, run._id);
		// The old workflow exits at its next getWatchState after the native check is durable.
		if (run.lifecycleWorkflowId !== undefined) return { lifecycleWorkflowId: undefined };
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

const fastModeBackfillMigrations = [
	internal.migrations.backfillThreadFastMode,
	internal.migrations.backfillRunFastMode
];

export const runFastModeBackfill = migrations.runner(fastModeBackfillMigrations);

const runExecutionBackfillMigrations = [
	internal.migrations.backfillRunExecution,
	internal.migrations.normalizeThreadRunningStatus
];

export const runExecutionBackfill = migrations.runner(runExecutionBackfillMigrations);

const completionStreamCleanupMigrations = [
	internal.migrations.removeRunCompletionStreamStateId,
	internal.migrations.deleteCompletionStreamStates
];

export const runCompletionStreamCleanup = migrations.runner(completionStreamCleanupMigrations);

export const runCompletionStreamCleanupAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const statuses = await migrations.getStatus(ctx, {
			migrations: completionStreamCleanupMigrations
		});
		if (!statuses.every((status) => status.isDone)) {
			await migrations.runSerially(ctx, completionStreamCleanupMigrations);
		}
		return null;
	}
});

export const removeRunCompletionStreamStateId = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.completionStreamStateId !== undefined) return { completionStreamStateId: undefined };
	}
});

export const deleteCompletionStreamStates = migrations.define({
	table: 'completionStreamStates',
	migrateOne: async (ctx, state) => {
		await ctx.db.delete('completionStreamStates', state._id);
	}
});

export const runExecutionBackfillAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const statuses = await migrations.getStatus(ctx, {
			migrations: runExecutionBackfillMigrations
		});
		if (!statuses.every((status) => status.isDone)) {
			await migrations.runSerially(ctx, runExecutionBackfillMigrations);
		}
		return null;
	}
});

export const backfillRunExecution = migrations.define({
	table: 'runs',
	migrateOne: async (ctx, run) => {
		await migrateRunExecution(ctx, run);
		if (run.status === 'awaiting_executor') return { status: 'running' as const };
	}
});

export const normalizeThreadRunningStatus = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.status === 'awaiting_executor') return { status: 'running' as const };
	}
});

export const runFastModeBackfillAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		let schedule = await ctx.db
			.query('migrationSchedules')
			.withIndex('by_name', (query) => query.eq('name', FAST_MODE_BACKFILL))
			.unique();
		if (!schedule) {
			const scheduleId = await ctx.db.insert('migrationSchedules', {
				name: FAST_MODE_BACKFILL,
				notBefore: now,
				startedAt: now
			});
			schedule = await ctx.db.get('migrationSchedules', scheduleId);
		}
		if (!schedule || schedule.completedAt !== undefined) return null;

		const statuses = await migrations.getStatus(ctx, { migrations: fastModeBackfillMigrations });
		if (statuses.every((status) => status.isDone)) {
			await ctx.db.patch('migrationSchedules', schedule._id, { completedAt: now });
			return null;
		}

		await migrations.runSerially(ctx, fastModeBackfillMigrations);
		return null;
	}
});

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
		return { status: status === 'awaiting_executor' ? ('running' as const) : status };
	}
});

export const backfillThreadFastMode = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.fastMode !== undefined && thread.serviceTier === undefined) return;
		return {
			fastMode: thread.fastMode ?? thread.serviceTier === 'fast',
			serviceTier: undefined
		};
	}
});

export const backfillRunFastMode = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.fastMode !== undefined && run.serviceTier === undefined) return;
		return {
			fastMode: run.fastMode ?? run.serviceTier === 'fast',
			serviceTier: undefined
		};
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
