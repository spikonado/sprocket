import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import {
	sectionDisplayOrder,
	writeCompletionSectionData,
	writeToolSectionData
} from '@convex/lib/transcriptSectionWrites';
import { historicalWork } from '@convex/lib/transcriptParts';

export const AUTOMATIC_CLEANUP_DELAY_MS = 48 * 60 * 60 * 1_000;
const PRODUCTION_ROLLOUT_CLEANUP = 'production-rollout-cleanup-2026-09';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const assignTranscriptSectionsAtWriteTime = migrations.define({
	table: 'threadTranscriptParts',
	batchSize: 4,
	migrateOne: async (ctx, part) => {
		const legacy = await ctx.db
			.query('threadTranscriptMemberships')
			.withIndex('by_threadId_and_number', (q) =>
				q.eq('threadId', part.threadId).eq('number', part.number)
			)
			.unique();
		const priorWork = historicalWork(part, part.work ?? legacy?.work);
		if (part.kind === 'completion' && part.completion) {
			const ranges = priorWork.ranges;
			const work = { ranges };
			const sections = new Map<
				string,
				{ sectionKey: string; sectionOrdinal: number; closed: boolean }
			>();
			for (const range of ranges) {
				if (sections.has(range.sectionKey)) continue;
				const old = await ctx.db
					.query('threadTranscriptWorkSections')
					.withIndex('by_threadId_and_key', (q) =>
						q.eq('threadId', part.threadId).eq('key', range.sectionKey)
					)
					.unique();
				sections.set(range.sectionKey, {
					sectionKey: range.sectionKey,
					sectionOrdinal: old?.sectionOrdinal ?? part.number * 8192 + range.start,
					closed: old?.closed ?? true
				});
			}
			await writeCompletionSectionData(ctx, {
				part: { ...part, work },
				work,
				sections: [...sections.values()],
				preserveExistingSummaries: true
			});
			return { work };
		}
		if (part.kind === 'tool' && part.tool) {
			const sectionKey =
				priorWork.sectionKey ?? `historical-tool:${part.runId}:${part.tool.callId}`;
			const old = await ctx.db
				.query('threadTranscriptWorkSections')
				.withIndex('by_threadId_and_key', (q) =>
					q.eq('threadId', part.threadId).eq('key', sectionKey)
				)
				.unique();
			await writeToolSectionData(ctx, {
				part: { ...part, work: { ranges: [], sectionKey } },
				sectionKey,
				sectionOrdinal: old?.sectionOrdinal ?? part.number * 8192,
				toolInvocationId: part.tool.toolInvocationId ?? part.tool.callId,
				started: part.tool.status === 'started',
				occurredAt: part._creationTime,
				preserveExistingSummary: true
			});
			return { work: { ranges: [], sectionKey } };
		}
		return { work: { ranges: [] } };
	}
});

export const deleteLegacyTranscriptMemberships = migrations.define({
	table: 'threadTranscriptMemberships',
	batchSize: 16,
	migrateOne: async (ctx, row) => {
		if (row.number === undefined) return;
		await ctx.db.delete('threadTranscriptMemberships', row._id);
	}
});

export const backfillTranscriptSectionDisplayOrder = migrations.define({
	table: 'threadTranscriptWorkSections',
	batchSize: 16,
	migrateOne: async (ctx, section) => {
		const run = await ctx.db.get('runs', section.runId);
		if (!run) throw new Error('Transcript section run not found.');
		const sectionOrdinal = section.sectionOrdinal ?? section.first.part * 8192 + section.first.item;
		return {
			sectionOrdinal,
			displayOrder: sectionDisplayOrder(run.startedAt, run._id, sectionOrdinal)
		};
	}
});

const WRITE_TIME_SECTION_MIGRATION = 'transcript-write-time-sections-v1';

export const runTranscriptWriteTimeSectionMigration = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const schedule = await ctx.db
			.query('migrationSchedules')
			.withIndex('by_name', (q) => q.eq('name', WRITE_TIME_SECTION_MIGRATION))
			.unique();
		if (schedule?.completedAt !== undefined) return null;
		let scheduleId = schedule?._id;
		if (!schedule) {
			scheduleId = await ctx.db.insert('migrationSchedules', {
				name: WRITE_TIME_SECTION_MIGRATION,
				notBefore: Date.now(),
				startedAt: Date.now()
			});
		} else if (schedule.startedAt === undefined) {
			await ctx.db.patch('migrationSchedules', schedule._id, { startedAt: Date.now() });
		}
		const migrationList = [
			internal.migrations.assignTranscriptSectionsAtWriteTime,
			internal.migrations.backfillTranscriptSectionDisplayOrder,
			internal.migrations.deleteLegacyTranscriptMemberships
		];
		const statuses = await migrations.getStatus(ctx, { migrations: migrationList });
		if (statuses.every((status) => status.isDone)) {
			await ctx.db.patch('migrationSchedules', scheduleId!, { completedAt: Date.now() });
			return null;
		}
		await migrations.runSerially(ctx, migrationList);
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
