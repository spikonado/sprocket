import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { vThreadSummary } from '@convex/lib/docs';
import { compareRunStartedAt } from '@convex/lib/runs';

export const vThreadSnapshotCategory = v.union(v.literal('active'), v.literal('archived'));

export type ThreadSnapshotCategory = Infer<typeof vThreadSnapshotCategory>;

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'awaiting_executor'] as const;

export function threadSnapshotCategory(
	archivedAt: number | undefined
): ThreadSnapshotCategory {
	return archivedAt !== undefined ? 'archived' : 'active';
}

export async function bumpThreadSnapshotRevision(
	ctx: MutationCtx,
	args: {
		userId: string;
		repositoryKey: string;
		category: ThreadSnapshotCategory;
	}
): Promise<void> {
	const repositoryKey = args.repositoryKey.trim();
	if (repositoryKey.length === 0) {
		return;
	}
	const existing = await ctx.db
		.query('threadSnapshotRevisions')
		.withIndex('by_userId_and_repositoryKey_and_category', (query) =>
			query
				.eq('userId', args.userId)
				.eq('repositoryKey', repositoryKey)
				.eq('category', args.category)
		)
		.unique();
	const now = Date.now();
	if (existing) {
		await ctx.db.patch('threadSnapshotRevisions', existing._id, {
			revision: existing.revision + 1,
			updatedAt: now
		});
		return;
	}
	await ctx.db.insert('threadSnapshotRevisions', {
		userId: args.userId,
		repositoryKey,
		category: args.category,
		revision: 1,
		updatedAt: now
	});
}

export async function bumpThreadSnapshotRevisions(
	ctx: MutationCtx,
	args: {
		userId: string;
		repositoryKey: string;
		categories: readonly ThreadSnapshotCategory[];
	}
): Promise<void> {
	for (const category of args.categories) {
		await bumpThreadSnapshotRevision(ctx, {
			userId: args.userId,
			repositoryKey: args.repositoryKey,
			category
		});
	}
}

export async function bumpThreadSnapshotForRecord(
	ctx: MutationCtx,
	record: Pick<Doc<'threadRecords'>, 'userId' | 'repositoryKey' | 'archivedAt'>
): Promise<void> {
	await bumpThreadSnapshotRevision(ctx, {
		userId: record.userId,
		repositoryKey: record.repositoryKey ?? '',
		category: threadSnapshotCategory(record.archivedAt)
	});
}

export async function bumpThreadSnapshotForThreadId(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	const record = await ctx.db.get('threadRecords', threadId);
	if (!record) {
		return;
	}
	await bumpThreadSnapshotForRecord(ctx, record);
}

export async function bumpThreadSnapshotForRun(
	ctx: MutationCtx,
	run: Pick<Doc<'runs'>, 'threadId'>
): Promise<void> {
	await bumpThreadSnapshotForThreadId(ctx, run.threadId);
}

export async function readSnapshotRevision(
	ctx: QueryCtx,
	args: {
		userId: string;
		repositoryKey: string;
		category: ThreadSnapshotCategory;
	}
): Promise<number> {
	const row = await ctx.db
		.query('threadSnapshotRevisions')
		.withIndex('by_userId_and_repositoryKey_and_category', (query) =>
			query
				.eq('userId', args.userId)
				.eq('repositoryKey', args.repositoryKey)
				.eq('category', args.category)
		)
		.unique();
	return row?.revision ?? 0;
}

export async function latestActiveRunForThread(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'runs'> | null> {
	let latest: Doc<'runs'> | null = null;
	for (const status of ACTIVE_RUN_STATUSES) {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId_status_startedAt', (query) =>
				query.eq('threadId', threadId).eq('status', status)
			)
			.order('desc')
			.first();
		if (run && (!latest || compareRunStartedAt(run, latest) > 0)) {
			latest = run;
		}
	}
	return latest;
}

export async function summarizeThreadRecord(
	ctx: QueryCtx | MutationCtx,
	record: Doc<'threadRecords'>
): Promise<Infer<typeof vThreadSummary>> {
	const activeRun = await latestActiveRunForThread(ctx, record._id);
	return {
		...record,
		threadId: record._id,
		repositoryKey: record.repositoryKey ?? '',
		title: record.title?.trim() || 'New thread',
		threadStatus: threadSnapshotCategory(record.archivedAt),
		latestRunStatus: activeRun?.status ?? null,
		latestRunId: activeRun?._id ?? null,
		latestRunStartedAt: activeRun?.startedAt,
		latestRunClaimExpiresAt: activeRun?.claimExpiresAt,
		hasActiveRun: activeRun !== null
	};
}
