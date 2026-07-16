import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from '@convex/_generated/server';
import { defaultServiceTier, normalizeModelId } from '@convex/lib/models';

/**
 * Temporary migration for the GPT-5.6 model rollout. Invoke once per table,
 * following each returned cursor until `isDone`, then remove the legacy model
 * validator and make `serviceTier` required in the schema.
 */
export const backfillModelConfigurations = internalMutation({
	args: {
		table: v.union(v.literal('threadRecords'), v.literal('runs')),
		paginationOpts: paginationOptsValidator
	},
	handler: async (ctx, args) => {
		const page =
			args.table === 'threadRecords'
				? await ctx.db.query('threadRecords').paginate(args.paginationOpts)
				: await ctx.db.query('runs').paginate(args.paginationOpts);
		let migrated = 0;
		for (const document of page.page) {
			const selectedModel = normalizeModelId(document.selectedModel);
			if (document.selectedModel === selectedModel && document.serviceTier !== undefined) continue;
			await ctx.db.patch(document._id, {
				selectedModel,
				serviceTier: document.serviceTier ?? defaultServiceTier
			});
			migrated += 1;
		}

		return {
			continueCursor: page.continueCursor,
			isDone: page.isDone,
			migrated
		};
	}
});
