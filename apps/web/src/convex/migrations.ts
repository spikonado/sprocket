import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

// `run` targets the currently live migration(s). Each deploy's cron calls it
// with no args; the runner picks up the pinned migration refs itself. Swap in
// the next migration when a future cleanup lands.
export const run = migrations.runner([internal.migrations.clearResponseMessageParts]);

/**
 * Clears the response-half payloads (`text`, `parts`) that runs wrote to
 * `threadMessages` before the local-transcript cleanup. Once every remaining
 * row is rewritable this way, `runs.responseMessageId` and
 * `threadMessages.parts` can be dropped from the schema. Run via:
 *   npx convex run migrations:clearResponseMessageParts '{ dryRun: true }'
 */
export const clearResponseMessageParts = migrations.define({
	table: 'threadMessages',
	customRange: (query) => query.withIndex('by_type_runId'),
	migrateOne: async (ctx, message) => {
		if (message.type !== 'response') {
			return;
		}
		if (message.text === '' && message.parts.length === 0) {
			return;
		}
		// Reads/writes the whole document on purpose: this migration's success
		// is part of the gate for deleting the oversized `parts` field, which
		// requires every stored row to survive a patch transaction.
		const current = await ctx.db.get('threadMessages', message._id);
		if (!current) {
			return;
		}
		await ctx.db.patch('threadMessages', message._id, { text: '', parts: [] });
	}
});
