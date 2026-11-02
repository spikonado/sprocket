import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, { schema, internalMutation });

export const backfillToolInvocationIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		if (!part.tool || part.tool.toolInvocationId !== undefined) return;

		// The source key is unique per thread, like an invocation ID.
		return { tool: { ...part.tool, toolInvocationId: part.sourceKey } };
	}
});

export const run = migrations.runner(internal.migrations.backfillToolInvocationIds);
