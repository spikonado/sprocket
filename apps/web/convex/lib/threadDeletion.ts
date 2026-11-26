import { internal } from '@convex/_generated/api';
import type { Doc, Id, TableNames } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { deleteFile } from '@convex/lib/files';
import { hasCleanupHeadroom } from '@convex/lib/runTerminal';

const CHILD_BATCH_SIZE = 16;

const MAX_DOCS_PER_BATCH = 256;

/** Deletes the row now, so its tree leaves every list at once, and the rest in the background. */
export async function deleteThread(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	await ctx.db.delete('threadRecords', thread._id);
	await ctx.scheduler.runAfter(0, internal.threads.deleteThreadData, {
		threadId: thread._id,
		userId: thread.userId
	});
}

class Batch {
	private docsLeft = MAX_DOCS_PER_BATCH;

	constructor(private readonly ctx: MutationCtx) {}

	/** Removes docs until `next` finds none. Returns false when the batch ran out first. */
	async removeEach<T>(
		next: () => Promise<T | null>,
		remove: (doc: T) => Promise<boolean>
	): Promise<boolean> {
		while (this.docsLeft > 0 && (await hasCleanupHeadroom(this.ctx))) {
			const doc = await next();

			if (!doc) return true;

			if (!(await remove(doc))) return false;
			this.docsLeft -= 1;
		}

		return false;
	}

	async deleteEach<Table extends TableNames>(
		table: Table,
		next: () => Promise<Doc<Table> | null>
	): Promise<boolean> {
		return await this.removeEach(next, async (doc) => {
			await this.ctx.db.delete(table, doc._id);

			return true;
		});
	}
}

async function deleteRun(ctx: MutationCtx, batch: Batch, run: Doc<'runs'>): Promise<boolean> {
	const done =
		(await batch.deleteEach('modelCallUsage', () =>
			ctx.db
				.query('modelCallUsage')
				.withIndex('by_runId_eventId', (q) => q.eq('runId', run._id))
				.first()
		)) &&
		(await batch.deleteEach('runExecutionStates', () =>
			ctx.db
				.query('runExecutionStates')
				.withIndex('by_runId', (q) => q.eq('runId', run._id))
				.first()
		));

	if (done) await ctx.db.delete('runs', run._id);

	return done;
}

async function deleteOwnRows(ctx: MutationCtx, threadId: Id<'threadRecords'>): Promise<boolean> {
	const batch = new Batch(ctx);
	const { db } = ctx;

	const steps = [
		() =>
			batch.deleteEach('executorJobs', () =>
				db
					.query('executorJobs')
					.withIndex('by_threadId_sequence', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.deleteEach('agentQuestions', () =>
				db
					.query('agentQuestions')
					.withIndex('by_threadId_sequence', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.deleteEach('threadTranscriptParts', () =>
				db
					.query('threadTranscriptParts')
					.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.deleteEach('threadTokenUsage', () =>
				db
					.query('threadTokenUsage')
					.withIndex('by_threadId_model', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.removeEach(
				() =>
					db
						.query('files')
						.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
						.first(),
				async (file) => {
					await deleteFile(ctx, file);

					return true;
				}
			),
		() =>
			batch.removeEach(
				() =>
					db
						.query('imageUploads')
						.withIndex('by_threadId_and_sha256_and_storageDeletedAt', (q) =>
							q.eq('threadId', threadId)
						)
						.first(),
				async (upload) => {
					if (upload.storageDeletedAt === undefined) await ctx.storage.delete(upload.storageId);
					await db.delete('imageUploads', upload._id);

					return true;
				}
			),
		() =>
			batch.removeEach(
				() =>
					db
						.query('runs')
						.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
						.first(),
				(run) => deleteRun(ctx, batch, run)
			),
		() =>
			batch.deleteEach('threadUsage', () =>
				db
					.query('threadUsage')
					.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.deleteEach('threadTranscriptStates', () =>
				db
					.query('threadTranscriptStates')
					.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
					.first()
			),
		() =>
			batch.deleteEach('threadHierarchyStates', () =>
				db
					.query('threadHierarchyStates')
					.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
					.first()
			)
	];

	for (const step of steps) {
		if (!(await step())) return false;
	}

	return true;
}

/** Deletes the next batch of a thread whose row is already gone. Returns false while work remains. */
export async function deleteThreadDataBatch(
	ctx: MutationCtx,
	thread: { threadId: Id<'threadRecords'>; userId: string }
): Promise<boolean> {
	const children = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_parentThreadId', (q) =>
			q.eq('userId', thread.userId).eq('parentThreadId', thread.threadId)
		)
		.take(CHILD_BATCH_SIZE);

	for (const child of children) await deleteThread(ctx, child);

	if (children.length === CHILD_BATCH_SIZE) return false;

	return await deleteOwnRows(ctx, thread.threadId);
}
