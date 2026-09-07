import { expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

it('backfills the original owner from the first historical prompt', async () => {
	const t = initConvexTest();
	const { subject, threadId } = await seedOwnedThread(t);
	const otherThreadId = await seedThreadRecord(t, subject, 'other');
	const file = await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['file']));
		const imageUploadId = await ctx.db.insert('imageUploads', {
			userId: subject,
			storageId,
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4,
			attached: true
		});
		for (const owner of [threadId, otherThreadId]) {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', owner))
				.first();
			if (!run) throw new Error('Missing fixture run');
			await ctx.db.insert('threadTranscriptParts', {
				threadId: owner,
				userId: subject,
				number: 0,
				sourceKey: `prompt:${owner}`,
				kind: 'prompt',
				runId: run._id,
				prompt: {
					text: 'Read',
					imageUploads: [
						{ storageId, imageUploadId, name: 'file.txt', mediaType: 'text/plain', size: 4 }
					]
				}
			});
		}
		return { imageUploadId, storageId };
	});
	await t.mutation(internal.migrations.backfillImageUploadThreadId, oneBatch);
	await t.mutation(internal.migrations.backfillImageUploadThreadId, oneBatch);
	const upload = await t.run((ctx) => ctx.db.get('imageUploads', file.imageUploadId));
	expect(upload?.threadId).toBe(threadId);
	expect(await t.run((ctx) => ctx.db.system.get('_storage', file.storageId))).not.toBeNull();
});

it('backfills the owner from storageId when the prompt no longer has imageUploadId', async () => {
	const t = initConvexTest();
	const { subject, threadId } = await seedOwnedThread(t);
	const file = await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['file']));
		const imageUploadId = await ctx.db.insert('imageUploads', {
			userId: subject,
			storageId,
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4,
			attached: true
		});
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
			.first();
		if (!run) throw new Error('Missing fixture run');
		await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: subject,
			number: 0,
			sourceKey: `prompt:${threadId}`,
			kind: 'prompt',
			runId: run._id,
			prompt: {
				text: 'Read',
				imageUploads: [{ storageId, name: 'file.txt', mediaType: 'text/plain', size: 4 }]
			}
		});
		return { imageUploadId, storageId };
	});
	await t.mutation(internal.migrations.backfillImageUploadThreadId, oneBatch);
	const upload = await t.run((ctx) => ctx.db.get('imageUploads', file.imageUploadId));
	expect(upload?.threadId).toBe(threadId);
});

it.each([false, true])(
	'strips attachment IDs including orphaned rows (orphaned: %s)',
	async (orphaned) => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const partId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['file']));
			const imageUploadId = await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 4,
				attached: true,
				threadId
			});
			if (orphaned) await ctx.db.delete('imageUploads', imageUploadId);
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.first();
			if (!run) throw new Error('Missing fixture run');
			return await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: subject,
				number: 0,
				sourceKey: `prompt:${threadId}`,
				kind: 'prompt',
				runId: run._id,
				prompt: {
					text: 'Read',
					imageUploads: [
						{ storageId, imageUploadId, name: 'file.txt', mediaType: 'text/plain', size: 4 }
					]
				}
			});
		});
		await t.mutation(internal.migrations.removeTranscriptAttachmentImageUploadIds, oneBatch);
		const part = await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId));
		expect(part?.prompt?.imageUploads[0]).toMatchObject({
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4,
			storageId: expect.any(String)
		});
		expect(part?.prompt?.imageUploads[0]).not.toHaveProperty('imageUploadId');
	}
);
