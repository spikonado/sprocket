import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { throughPartNumberForRunId } from '@convex/lib/contextHandoff';
import { normalizeCompletionTiming } from '@convex/lib/transcriptParts';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const run = migrations.runner([
	internal.migrations.removeRunPromptMessageIds,
	internal.migrations.removeImageUploadMessageIds,
	internal.migrations.backfillTranscriptTiming,
	internal.migrations.backfillContextSummaryThroughPartNumber
]);

export const runTranscriptTiming = migrations.runner(internal.migrations.backfillTranscriptTiming);

export const backfillTranscriptTiming = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		if (
			!part.completion?.items.some(
				(item) => item.startedAt === undefined || item.completedAt === undefined
			)
		)
			return;
		return { completion: normalizeCompletionTiming(part.completion) };
	}
});

export const removeRunPromptMessageIds = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.promptMessageId === undefined) return;
		return { promptMessageId: undefined };
	}
});

export const removeImageUploadMessageIds = migrations.define({
	table: 'imageUploads',
	migrateOne: (_ctx, upload) => {
		if (upload.messageIds === undefined) return;
		return { messageIds: undefined };
	}
});

export const backfillContextSummaryThroughPartNumber = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		if (thread.contextSummaryThroughPartNumber !== undefined) return;
		if (!thread.contextSummaryThroughRunId) return;
		return {
			contextSummaryThroughPartNumber: await throughPartNumberForRunId(
				ctx,
				thread._id,
				thread.contextSummaryThroughRunId
			)
		};
	}
});

export const backfillThreadStatus = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', thread._id))
			.order('desc')
			.first();
		if (!latestRun) {
			const usageRows = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', thread._id))
				.collect();
			for (const usage of usageRows) await ctx.db.delete('threadUsage', usage._id);
			await ctx.db.delete('threadRecords', thread._id);
			return;
		}
		if (thread.status !== latestRun.status) {
			await ctx.db.patch('threadRecords', thread._id, { status: latestRun.status });
		}
	}
});
