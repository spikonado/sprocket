import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';
import { normalizeExecutorJobResult, removeLegacyCommandStreams } from '@convex/lib/commandResults';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

// `run` targets the currently live migration(s). Each deploy's cron calls it
// with no args; the runner picks up the pinned migration refs itself. Swap in
// the next migration when a future cleanup lands.
export const run = migrations.runner([
	internal.migrations.clearResponseMessageParts,
	internal.migrations.removeExecutorJobCommandStreams,
	internal.migrations.removeTranscriptCommandStreams
]);

export const removeExecutorJobCommandStreams = migrations.define({
	table: 'executorJobs',
	migrateOne: (_ctx, job) => {
		if (job.result === undefined) return;
		const result = normalizeExecutorJobResult(job.kind, job.result);
		if (result === job.result) return;
		return { result };
	}
});

export const removeTranscriptCommandStreams = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		if (part.kind !== 'tool' || !part.tool || part.tool.output === undefined) return;
		const output = removeLegacyCommandStreams(part.tool.name, part.tool.output);
		if (output === part.tool.output) return;
		return { tool: { ...part.tool, output } };
	}
});

/**
 * Clears the response-half payloads (`text`, `parts`) that runs wrote to
 * `threadMessages` before the local-transcript cleanup. Once every remaining
 * row is rewritable this way, `runs.responseMessageId` and
 * `threadMessages.parts` can be dropped from the schema. Run via:
 *   npx convex run migrations:clearResponseMessageParts '{ dryRun: true }'
 *
 * Scoped to `type === 'response'` rows so prompts are not re-read on every
 * cron tick while the compatibility gate is still open.
 */
export const clearResponseMessageParts = migrations.define({
	table: 'threadMessages',
	customRange: (query) => query.withIndex('by_type_runId', (range) => range.eq('type', 'response')),
	// Leftover `parts` can sit near the 1 MiB document cap; the default page of 100 exceeds the 16 MiB read limit.
	batchSize: 1,
	migrateOne: (_ctx, message) => {
		if (message.text === '' && message.parts.length === 0) {
			return;
		}
		return { text: '', parts: [] };
	}
});
