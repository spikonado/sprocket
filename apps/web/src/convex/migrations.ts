import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const run = migrations.runner([
	internal.migrations.removeRunPromptMessageIds,
	internal.migrations.removeImageUploadMessageIds
]);

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
