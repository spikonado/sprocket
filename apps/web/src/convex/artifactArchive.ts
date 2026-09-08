import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import {
	asArchiveDb,
	leftoverLegacyPresent as leftoverRowsExist,
	runArchivePage,
	vArchivePageResult
} from '@convex/lib/artifactArchive';

export const archiveLegacyArtifactsPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: vArchivePageResult,
	handler: async (ctx, args) => {
		return await runArchivePage(asArchiveDb(ctx.db), { cursor: args.cursor });
	}
});

export const leftoverLegacyPresent = internalQuery({
	args: {},
	returns: v.object({ leftover: v.boolean() }),
	handler: async (ctx) => {
		return { leftover: await leftoverRowsExist(asArchiveDb(ctx.db)) };
	}
});
