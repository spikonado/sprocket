import { Migrations } from '@convex-dev/migrations';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import schema from '@convex/schema';
import { coercePersistedSelection, retiredModelIds } from '@convex/lib/models';
import {
	isReadBudgetError,
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

const TRANSCRIPT_NUMBERING_INCOMPLETE = 'Transcript numbering incomplete';

async function verifyTranscriptNumberingOrContinue(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	userId: string,
	fromNumber = 0
): Promise<void> {
	const result = await verifyThreadTranscriptNumbering(ctx, threadId, userId, fromNumber);
	if (result.status === 'complete') {
		return;
	}
	if (result.status === 'incomplete') {
		throw new Error(`${TRANSCRIPT_NUMBERING_INCOMPLETE} for thread ${threadId}`);
	}
	if (fromNumber > 0 && result.nextNumber <= fromNumber) {
		throw new Error(`Transcript numbering verify made no progress for thread ${threadId}`);
	}
	await ctx.scheduler.runAfter(0, internal.migrations.continueVerifyThreadTranscriptReplicas, {
		threadId,
		userId,
		fromNumber: result.nextNumber
	});
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
	// One function execution verifies many threads; keep this small so part
	// scans stay under Convex's per-transaction read budget.
	batchSize: 20,
	migrateOne: async (ctx, thread) => {
		try {
			await verifyTranscriptNumberingOrContinue(ctx, thread._id, thread.userId);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (
				isTransientMigrationError(error) ||
				error.message.includes(TRANSCRIPT_NUMBERING_INCOMPLETE)
			) {
				throw error;
			}
			if (isReadBudgetError(error)) {
				await ctx.scheduler.runAfter(
					0,
					internal.migrations.continueVerifyThreadTranscriptReplicas,
					{
						threadId: thread._id,
						userId: thread.userId,
						fromNumber: 0
					}
				);
				return;
			}
			console.error(`Skipping poison transcript thread ${thread._id}:`, error);
		}
	}
});

export const continueVerifyThreadTranscriptReplicas = internalMutation({
	args: {
		threadId: v.id('threadRecords'),
		userId: v.string(),
		fromNumber: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await verifyTranscriptNumberingOrContinue(ctx, args.threadId, args.userId, args.fromNumber);
		return null;
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
