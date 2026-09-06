import { expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

it('backfills the original owner and removes the superseded retention data', async () => {
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
			attached: true,
			threadRefsMigratedAt: 1
		});
		await ctx.db.patch('threadRecords', threadId, { updatedAt: Date.now() });
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
			await ctx.db.insert('threadAttachmentRefs', { threadId: owner, imageUploadId });
		}
		return { imageUploadId, storageId };
	});
	await t.mutation(internal.migrations.backfillImageUploadThreadId, oneBatch);
	await t.mutation(internal.migrations.backfillImageUploadThreadId, oneBatch);
	await t.mutation(internal.migrations.removeThreadUpdatedAt, oneBatch);
	await t.mutation(internal.migrations.removeImageUploadThreadRefsMigratedAt, oneBatch);
	await t.mutation(internal.migrations.removeThreadAttachmentRefs, oneBatch);
	const upload = await t.run((ctx) => ctx.db.get('imageUploads', file.imageUploadId));
	expect(upload?.threadId).toBe(threadId);
	expect(upload?.threadRefsMigratedAt).toBeUndefined();
	const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
	expect(thread?.updatedAt).toBeUndefined();
	expect(await t.run((ctx) => ctx.db.query('threadAttachmentRefs').take(1))).toEqual([]);
	expect(await t.run((ctx) => ctx.db.system.get('_storage', file.storageId))).not.toBeNull();
});
