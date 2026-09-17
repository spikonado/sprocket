import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { getUserId } from './lib/auth';
import { INBOX_WORKING_MIGRATION, MAX_INBOX_REPOSITORIES, vInboxState } from './lib/inboxState';
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

		if (args.state === 'unsettled') {
			const migration = await ctx.db
				.query('migrationSchedules')
				.withIndex('by_name', (q) => q.eq('name', INBOX_WORKING_MIGRATION))
				.unique();
			if (migration?.completedAt !== undefined) {
				const streams = repositoryKeys.map((repositoryKey) =>
					stream(ctx.db, schema)
						.query('threadRecords')
						.withIndex('by_userId_repo_archivedAt_working_lastMessageAt', (range) =>
							range
								.eq('userId', userId)
								.eq('repositoryKey', repositoryKey)
								.eq('archivedAt', undefined)
						)
						.order('desc')
				);
				return await mergedStream(streams, ['working', 'lastMessageAt', '_creationTime']).paginate(
					args.paginationOpts
				);
			}

			const streams = repositoryKeys.map((repositoryKey) =>
				stream(ctx.db, schema)
					.query('threadRecords')
					.withIndex('by_userId_and_repositoryKey_and_archivedAt_and_lastMessageAt', (range) =>
						range
							.eq('userId', userId)
							.eq('repositoryKey', repositoryKey)
							.eq('archivedAt', undefined)
					)
					.order('desc')
			);
			return await mergedStream(streams, ['lastMessageAt', '_creationTime']).paginate(
				args.paginationOpts
			);
		}

		const streams = repositoryKeys.map((repositoryKey) =>
			stream(ctx.db, schema)
				.query('threadRecords')
				.withIndex('by_userId_and_repositoryKey_and_archivedAt_and_lastMessageAt', (range) =>
					range.eq('userId', userId).eq('repositoryKey', repositoryKey).gt('archivedAt', 0)
				)
				.order('desc')
		);

		return await mergedStream(streams, ['archivedAt', 'lastMessageAt', '_creationTime']).paginate(
			args.paginationOpts
		);
	}
});
