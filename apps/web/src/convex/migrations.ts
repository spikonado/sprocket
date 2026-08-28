import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { coercePersistedSelection, retiredModelIds } from '@convex/lib/models';
import {
	migrateLegacyRunTranscript,
	verifyThreadTranscriptNumbering
} from '@convex/lib/transcriptMigrate';
import { backfillUsageLedgerBaseline } from '@convex/lib/threadUsage';
import { isRunFinalStatus } from '@convex/lib/validators';
import { startRunLifecycle } from '@convex/runLifecycle';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const run = migrations.runner();

function isTransientMigrationError(error: Error): boolean {
	return /conflict|optimistic|try again|too much contention/i.test(error.message);
}

function rewriteSelection(modelId: string, serviceTier: string) {
	if (!retiredModelIds.some((id) => id === modelId)) return;
	const next = coercePersistedSelection(modelId, serviceTier);
	if (next.modelId === modelId && next.serviceTier === serviceTier) return;
	return { selectedModel: next.modelId, serviceTier: next.serviceTier };
}

export const startMissingRunLifecycles = migrations.define({
	table: 'runs',
	migrateOne: async (ctx, run) => {
		if (isRunFinalStatus(run.status) || run.lifecycleWorkflowId) {
			return;
		}
		try {
			const lifecycleWorkflowId = await startRunLifecycle(ctx, run._id);
			await ctx.db.patch('runs', run._id, { lifecycleWorkflowId });
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (isTransientMigrationError(error)) throw error;
			console.error(`Skipping poison run lifecycle ${run._id}:`, error);
		}
	}
});

export const migrateLegacyRunTranscriptParts = migrations.define({
	table: 'runs',
	migrateOne: async (ctx, run) => {
		try {
			await migrateLegacyRunTranscript(ctx, run);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (isTransientMigrationError(error)) throw error;
			console.error(`Skipping poison transcript run ${run._id}:`, error);
		}
	}
});

export const verifyThreadTranscriptReplicas = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		try {
			const complete = await verifyThreadTranscriptNumbering(ctx, thread._id, thread.userId);
			if (!complete) {
				throw new Error(`Transcript numbering incomplete for thread ${thread._id}`);
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (isTransientMigrationError(error) || error.message.includes('numbering incomplete')) {
				throw error;
			}
			console.error(`Skipping poison transcript thread ${thread._id}:`, error);
		}
	}
});

export const backfillThreadUsageLedger = migrations.define({
	table: 'threadUsage',
	migrateOne: async (ctx, usageRow) => {
		try {
			await backfillUsageLedgerBaseline(ctx, usageRow);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (isTransientMigrationError(error)) throw error;
			console.error(`Skipping poison usage row ${usageRow._id}:`, error);
		}
	}
});

export const rewriteRetiredThreadModels = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, doc) => rewriteSelection(doc.selectedModel, doc.serviceTier)
});

export const rewriteRetiredRunModels = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, doc) => rewriteSelection(doc.selectedModel, doc.serviceTier)
});

export const backfillThreadRepositoryKeys = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		if (thread.projectId === undefined) {
			return;
		}
		if (thread.repositoryKey) {
			return { projectId: undefined };
		}
		const project = await ctx.db.get('projects', thread.projectId);
		if (!project) {
			return;
		}
		return { repositoryKey: project.repositoryKey, projectId: undefined };
	}
});

export const unsetRunProjectIds = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.projectId === undefined) {
			return;
		}
		return { projectId: undefined };
	}
});

export const unsetExecutorJobProjectIds = migrations.define({
	table: 'executorJobs',
	migrateOne: (_ctx, job) => {
		if (job.projectId === undefined) {
			return;
		}
		return { projectId: undefined };
	}
});

export const runSeries = migrations.runner([
	internal.migrations.startMissingRunLifecycles,
	internal.migrations.migrateLegacyRunTranscriptParts,
	internal.migrations.verifyThreadTranscriptReplicas,
	internal.migrations.backfillThreadUsageLedger,
	internal.migrations.rewriteRetiredThreadModels,
	internal.migrations.rewriteRetiredRunModels,
	internal.migrations.backfillThreadRepositoryKeys,
	internal.migrations.unsetRunProjectIds,
	internal.migrations.unsetExecutorJobProjectIds
]);
