import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { getUserId } from './lib/auth';
import { MAX_INBOX_REPOSITORIES, vInboxState } from './lib/inboxState';
import { rootThreadsPage, searchRootThreads } from './lib/threadListing';
import schema from './schema';

export const list = query({
	args: {
		state: vInboxState,
		repositoryKeys: v.array(v.string()),
		/** Title search. Returns every matching root thread as one page, in relevance order. */
		query: v.optional(v.string()),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(schema.doc('threadRecords')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const repositoryKeys = [...new Set(args.repositoryKeys)];

		if (repositoryKeys.length === 0) {
			throw new Error('Choose at least one project.');
		}

		if (repositoryKeys.length > MAX_INBOX_REPOSITORIES) {
			throw new Error(`Choose at most ${MAX_INBOX_REPOSITORIES} projects.`);
		}

		const search = args.query?.trim();

		if (search) {
			const page = await searchRootThreads(ctx, userId, search, repositoryKeys, [args.state]);

			return { page, isDone: true, continueCursor: '' };
		}

		return await rootThreadsPage(ctx, userId, args.state, repositoryKeys, args.paginationOpts);
	}
});
