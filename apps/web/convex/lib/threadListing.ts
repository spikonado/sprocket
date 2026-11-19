import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type { PaginationOptions } from 'convex/server';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import type { Infer } from 'convex/values';
import { inboxState, type InboxState } from '@convex/lib/inboxState';
import { latestRunForThread } from '@convex/lib/runExecution';
import { hierarchyState, threadRoot } from '@convex/lib/threadHierarchy';
import type {
	RepositoryScope,
	vListThreadsResult,
	vSubagentSettings
} from '@convex/lib/validators';
import schema from '@convex/schema';

type ReadCtx = QueryCtx | MutationCtx;

// Convex returns at most 1024 search results; titles past the first few hundred matches aren't useful.
const SEARCH_MATCH_LIMIT = 256;

export function threadSettings(
	source: Doc<'threadRecords'> | Doc<'runs'>
): Infer<typeof vSubagentSettings> {
	return {
		model: source.selectedModel,
		reasoning: source.reasoningEffort,
		fast: source.fastMode,
		completionProvider: source.completionProvider ?? 'spikonado'
	};
}

export async function rootThreadsPage(
	ctx: ReadCtx,
	userId: string,
	state: InboxState,
	repositoryKeys: RepositoryScope,
	paginationOpts: PaginationOptions
) {
	const rows = stream(ctx.db, schema).query('threadRecords');

	const streams =
		repositoryKeys === 'all'
			? [
					rows
						.withIndex('by_userId_parentThreadId_archivedAt_lastMessageAt', (range) => {
							const roots = range.eq('userId', userId).eq('parentThreadId', undefined);

							return state === 'unsettled'
								? roots.eq('archivedAt', undefined)
								: roots.gt('archivedAt', 0);
						})
						.order('desc')
				]
			: [...new Set(repositoryKeys)].map((repositoryKey) =>
					rows
						.withIndex(
							'by_userId_parentThreadId_repositoryKey_archivedAt_lastMessageAt',
							(range) => {
								const project = range
									.eq('userId', userId)
									.eq('parentThreadId', undefined)
									.eq('repositoryKey', repositoryKey);

								return state === 'unsettled'
									? project.eq('archivedAt', undefined)
									: project.gt('archivedAt', 0);
							}
						)
						.order('desc')
				);

	return await mergedStream(
		streams,
		state === 'unsettled'
			? ['lastMessageAt', '_creationTime']
			: ['archivedAt', 'lastMessageAt', '_creationTime']
	).paginate(paginationOpts);
}

async function searchTitles(
	ctx: ReadCtx,
	userId: string,
	query: string,
	repositoryKeys: RepositoryScope
) {
	if (repositoryKeys === 'all') {
		return await ctx.db
			.query('threadRecords')
			.withSearchIndex('search_title', (search) =>
				search.search('title', query).eq('userId', userId)
			)
			.take(SEARCH_MATCH_LIMIT);
	}

	const keys = [...new Set(repositoryKeys)];
	const perProjectLimit = Math.ceil(SEARCH_MATCH_LIMIT / keys.length);

	const perProject = await Promise.all(
		keys.map((repositoryKey) =>
			ctx.db
				.query('threadRecords')
				.withSearchIndex('search_title', (search) =>
					search.search('title', query).eq('userId', userId).eq('repositoryKey', repositoryKey)
				)
				.take(perProjectLimit)
		)
	);

	// Relevance scores aren't comparable across searches, so interleave each project's ranking.
	const longest = Math.max(...perProject.map((matches) => matches.length));

	const interleaved = Array.from({ length: longest }, (_, rank) =>
		perProject.flatMap((matches) => (rank < matches.length ? [matches[rank]] : []))
	).flat();

	return interleaved.slice(0, SEARCH_MATCH_LIMIT);
}

/** Root threads whose own or subagent titles match, in relevance order. */
export async function searchRootThreads(
	ctx: ReadCtx,
	userId: string,
	query: string,
	repositoryKeys: RepositoryScope,
	states: readonly InboxState[]
) {
	const roots = new Map<Id<'threadRecords'>, Doc<'threadRecords'>>();

	for (const match of await searchTitles(ctx, userId, query, repositoryKeys)) {
		const root = await threadRoot(ctx.db, match);

		if (!roots.has(root._id) && states.includes(inboxState(root))) roots.set(root._id, root);
	}

	return [...roots.values()];
}

export async function searchChildThreads(
	ctx: ReadCtx,
	parent: Doc<'threadRecords'>,
	query: string
) {
	return await ctx.db
		.query('threadRecords')
		.withSearchIndex('search_title', (search) =>
			search.search('title', query).eq('userId', parent.userId).eq('parentThreadId', parent._id)
		)
		.take(SEARCH_MATCH_LIMIT);
}

export async function threadSummary(
	ctx: ReadCtx,
	thread: Doc<'threadRecords'>
): Promise<Infer<typeof vListThreadsResult>['threads'][number]> {
	const latest = await latestRunForThread(ctx.db, thread._id);
	const hierarchy = await hierarchyState(ctx.db, thread._id);

	return {
		threadId: thread._id,
		title: thread.title,
		status: latest?.status ?? thread.status,
		lastError: latest?.lastError,
		parentThreadId: thread.parentThreadId,
		repositoryKey: thread.repositoryKey,
		lastMessageAt: new Date(thread.lastMessageAt).toISOString(),
		settled: thread.archivedAt !== undefined,
		descendantCount: hierarchy?.descendantCount ?? 0,
		settings: threadSettings(thread),
		pullRequests: thread.pullRequests
	};
}
