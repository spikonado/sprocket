import { v, type Infer } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalMutation, mutation, type MutationCtx } from '@convex/_generated/server';
import { getUserId } from '@convex/lib/auth';
import { bumpRegistry } from '@convex/lib/artifactRegistry';
import { MAX_ARTIFACT_CONTENT_BYTES } from '@convex/artifacts';

const THREAD_MOVE_BATCH_SIZE = 100;

// Each patch reads and rewrites the whole artifact, so stay far below the
// per-mutation read and write limits even when every artifact is full.
const ARTIFACT_MOVE_BATCH_SIZE = Math.floor(4_000_000 / MAX_ARTIFACT_CONTENT_BYTES);

const vMoveBatchArgs = v.object({ userId: v.string(), from: v.string(), to: v.string() });

// The host calls this when a remote-less project gains an `origin` remote. Unlike
// threads.moveToProject, the workspace stays the same, so cwd and active runs are kept.
export const move = mutation({
	args: { from: v.string(), to: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const from = args.from.trim();
		const to = args.to.trim();

		if (!from || !to) throw new Error('Repository keys are required.');

		if (from === to) return null;

		await moveBatch(ctx, { userId: await getUserId(ctx), from, to });

		return null;
	}
});

export const continueMove = internalMutation({
	args: vMoveBatchArgs,
	returns: v.null(),
	handler: async (ctx, args) => {
		await moveBatch(ctx, args);

		return null;
	}
});

async function moveBatch(ctx: MutationCtx, args: Infer<typeof vMoveBatchArgs>) {
	const { userId, from, to } = args;

	const threads = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_and_repositoryKey', (q) =>
			q.eq('userId', userId).eq('repositoryKey', from)
		)
		.take(THREAD_MOVE_BATCH_SIZE);

	const artifacts = await ctx.db
		.query('artifacts')
		.withIndex('by_userId_and_repositoryKey_and_scope', (q) =>
			q.eq('userId', userId).eq('repositoryKey', from)
		)
		.take(ARTIFACT_MOVE_BATCH_SIZE);

	for (const thread of threads) {
		await ctx.db.patch('threadRecords', thread._id, { repositoryKey: to });
	}

	for (const artifact of artifacts) {
		await ctx.db.patch('artifacts', artifact._id, { repositoryKey: to });
	}

	if (artifacts.length > 0) {
		await bumpRegistry(ctx, userId, from);
		await bumpRegistry(ctx, userId, to);
	}

	if (threads.length === THREAD_MOVE_BATCH_SIZE || artifacts.length === ARTIFACT_MOVE_BATCH_SIZE) {
		await ctx.scheduler.runAfter(0, internal.repositoryKeys.continueMove, args);
	}
}
