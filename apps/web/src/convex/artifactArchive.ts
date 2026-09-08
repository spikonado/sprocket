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
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.object({
		leftover: v.boolean(),
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null())
	}),
	handler: async (ctx, args) => {
		return await leftoverRowsExist(asArchiveDb(ctx.db), args.cursor ?? null);
	}
});
