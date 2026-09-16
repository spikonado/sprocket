import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { getUserId } from './lib/auth';
import { MAX_INBOX_REPOSITORIES, vInboxState } from './lib/inboxState';
import schema from './schema';

export const list = query({
	args: {
		state: vInboxState,
		repositoryKeys: v.array(v.string()),
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

		const streams = repositoryKeys.map((repositoryKey) => {
			const rows = stream(ctx.db, schema)
				.query('threadRecords')
				.withIndex('by_userId_and_repositoryKey_and_archivedAt_and_lastMessageAt', (range) => {
					const project = range.eq('userId', userId).eq('repositoryKey', repositoryKey);
					return args.state === 'unsettled'
						? project.eq('archivedAt', undefined)
						: project.gt('archivedAt', 0);
				})
				.order('desc');
			return rows;
		});

		return await mergedStream(
			streams,
			args.state === 'unsettled'
				? ['lastMessageAt', '_creationTime']
				: ['archivedAt', 'lastMessageAt', '_creationTime']
		).paginate(args.paginationOpts);
	}
});
