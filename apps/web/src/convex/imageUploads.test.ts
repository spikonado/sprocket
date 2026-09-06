import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { GenericDatabaseWriter, GenericDataModel, WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	ATTACHMENT_CLEANUP_REF_BATCH,
	ATTACHMENT_RETENTION_MS,
	expireUploadIfInactive
} from '@convex/lib/attachmentRetention';
import { initConvexTest, insertQueuedRun, seedOwnedThread, seedThreadRecord } from './test.setup';

async function storeUpload(
	t: ReturnType<typeof initConvexTest>,
	args: {
		bytes: string;
		type?: string;
	}
) {
	return await t.run(async (ctx) => {
		const blob =
			args.type === undefined
				? new Blob([args.bytes])
				: new Blob([args.bytes], { type: args.type });
		const storageId = await ctx.storage.store(blob);
		// convex-test's storeBlob syscall omits the Content-Type metadata.
		if (args.type) {
			const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
			await db.patch(storageId, { contentType: args.type });
		}
		return storageId;
	});
}

describe('imageUploads.register', () => {
	it('requires authentication', async () => {
		const t = initConvexTest();
		const storageId = await storeUpload(t, { bytes: 'hello', type: 'text/plain' });
		await expect(t.mutation(api.imageUploads.generateUploadUrl, {})).rejects.toThrow(
			'Authentication required'
		);
		await expect(
			t.mutation(api.imageUploads.register, {
				storageId,
				name: 'notes.txt'
			})
		).rejects.toThrow('Authentication required');
	});

	it('accepts unknown MIME types and missing content types', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const pdfStorageId = await storeUpload(t, {
			bytes: 'pdf-bytes',
			type: 'application/pdf'
		});
		const blobStorageId = await storeUpload(t, {
			bytes: 'raw'
		});

		const pdf = await asUser.mutation(api.imageUploads.register, {
			storageId: pdfStorageId,
			name: '  spec.pdf  '
		});
		expect(pdf).toMatchObject({
			name: 'spec.pdf',
			mediaType: 'application/pdf',
			size: 9
		});
		expect('imageUploadId' in pdf).toBe(true);
		expect('url' in pdf).toBe(true);

		const blob = await asUser.mutation(api.imageUploads.register, {
			storageId: blobStorageId,
			name: 'blob.bin'
		});
		expect(blob).toMatchObject({
			name: 'blob.bin',
			mediaType: 'application/octet-stream',
			size: 3
		});
	});

	it('rejects empty filenames and deletes the stored blob', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_alice' });
		const storageId = await storeUpload(t, {
			bytes: 'x',
			type: 'text/plain'
		});

		expect(
			await asUser.mutation(api.imageUploads.register, {
				storageId,
				name: '   '
			})
		).toEqual({ error: 'Filename must be between 1 and 255 characters.' });
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
	});

	it('registers files larger than the former image limit', async () => {
		const t = initConvexTest();
		const size = 11 * 1024 * 1024;
		const storageId = await storeUpload(t, { bytes: 'x'.repeat(size), type: 'application/zip' });
		const result = await t.withIdentity({ subject: 'alice' }).mutation(api.imageUploads.register, {
			storageId,
			name: 'archive.zip'
		});
		expect(result).toMatchObject({ name: 'archive.zip', size, mediaType: 'application/zip' });
	});

	it('does not let another user claim a stored file', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'alice' });
		const bob = t.withIdentity({ subject: 'bob' });
		const storageId = await storeUpload(t, {
			bytes: 'hello',
			type: 'text/plain'
		});
		const registered = await alice.mutation(api.imageUploads.register, {
			storageId,
			name: 'notes.txt'
		});
		expect('imageUploadId' in registered).toBe(true);

		await expect(
			bob.mutation(api.imageUploads.register, { storageId, name: 'stolen.txt' })
		).rejects.toThrow('Uploaded file belongs to another user.');
	});
});

describe('owned file attachments', () => {
	it('allows more than four mixed files and rejects duplicate ids', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const imageUploadIds = await t.run(async (ctx) => {
			const ids: Id<'imageUploads'>[] = [];
			for (const [index, type] of [
				'application/pdf',
				'text/plain',
				'',
				'image/png',
				'application/zip'
			].entries()) {
				const storageId = await ctx.storage.store(
					type ? new Blob([`file-${index}`], { type }) : new Blob([`file-${index}`])
				);
				ids.push(
					await ctx.db.insert('imageUploads', {
						userId: subject,
						storageId,
						name: `file-${index}`,
						mediaType: type || 'application/octet-stream',
						size: 6,
						attached: false
					})
				);
			}
			return ids;
		});

		const created = await insertQueuedRun(t, asUser, {
			submissionId: 'five-files',
			threadId,
			prompt: 'Read these',
			imageUploadIds,
			executionSecret: 'five-files-secret'
		});
		expect(created.created).toBe(true);
		expect(created.promptPart?.prompt?.imageUploads).toHaveLength(5);
		expect(created.promptPart?.prompt?.imageUploads.map((upload) => upload.mediaType)).toEqual([
			'application/pdf',
			'text/plain',
			'application/octet-stream',
			'image/png',
			'application/zip'
		]);

		await expect(
			insertQueuedRun(t, asUser, {
				submissionId: 'duplicate-files',
				threadId,
				prompt: 'Read these',
				imageUploadIds: [imageUploadIds[0], imageUploadIds[0]],
				executionSecret: 'duplicate-files-secret'
			})
		).rejects.toThrow('The same file cannot be attached more than once.');
		await t.run(async (ctx) => {
			const upload = await ctx.db.get('imageUploads', imageUploadIds[0]);
			if (!upload) throw new Error('Missing test upload');
			await ctx.storage.delete(upload.storageId);
		});
		const context = await asUser.query(api.agentRuntime.getContext, {
			runId: created.runId,
			executionSecret: 'five-files-secret',
			attachmentsAsPaths: true
		});
		expect(context.promptAttachments).toEqual([]);
		await expect(
			asUser.query(api.agentRuntime.getContext, {
				runId: created.runId,
				executionSecret: 'five-files-secret'
			})
		).rejects.toThrow('One or more file attachments are unavailable.');
	});
});

const staleActivityAt = () => Date.now() - ATTACHMENT_RETENTION_MS - 1;

async function insertStoredUpload(
	t: ReturnType<typeof initConvexTest>,
	args: {
		userId: string;
		name: string;
		attached: boolean;
		threadRefsMigratedAt?: number;
	}
) {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['bytes'], { type: 'text/plain' }));
		const insert: WithoutSystemFields<Doc<'imageUploads'>> = {
			userId: args.userId,
			storageId,
			name: args.name,
			mediaType: 'text/plain',
			size: 5,
			attached: args.attached
		};
		if (args.threadRefsMigratedAt !== undefined) {
			insert.threadRefsMigratedAt = args.threadRefsMigratedAt;
		}
		const imageUploadId = await ctx.db.insert('imageUploads', insert);
		return { imageUploadId, storageId };
	});
}

async function expireAttachedStorage(t: ReturnType<typeof initConvexTest>) {
	await t.mutation(internal.imageUploads.cleanupExpired, {});
	await t.finishAllScheduledFunctions(() => undefined);
}

describe('attached file retention', () => {
	it('creates thread refs and a migration stamp on first attach', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const { imageUploadId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'notes.txt',
			attached: false
		});

		await insertQueuedRun(t, asUser, {
			submissionId: 'attach-stamp',
			threadId,
			prompt: 'Read this',
			imageUploadIds: [imageUploadId],
			executionSecret: 'attach-stamp-secret'
		});

		const state = await t.run(async (ctx) => {
			const upload = await ctx.db.get('imageUploads', imageUploadId);
			const ref = await ctx.db
				.query('threadAttachmentRefs')
				.withIndex('by_threadId_and_imageUploadId', (query) =>
					query.eq('threadId', threadId).eq('imageUploadId', imageUploadId)
				)
				.unique();
			return { upload, ref };
		});
		expect(state.upload).toMatchObject({
			attached: true,
			threadRefsMigratedAt: expect.any(Number)
		});
		expect(state.ref).toMatchObject({ threadId, imageUploadId });
	});

	it('deletes Convex bytes after a week of inactivity and keeps transcript metadata', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'notes.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
			await ctx.db.patch('threadRecords', threadId, {
				status: 'completed',
				updatedAt: staleActivityAt()
			});
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.order('desc')
				.first();
			if (!run) throw new Error('Missing seed run');
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: subject,
				number: 0,
				sourceKey: `prompt:${run._id}`,
				kind: 'prompt',
				runId: run._id,
				prompt: {
					text: 'Read this',
					imageUploads: [
						{
							imageUploadId,
							name: 'notes.txt',
							mediaType: 'text/plain',
							size: 5,
							storageId
						}
					]
				}
			});
		});

		await expireAttachedStorage(t);

		const after = await t.run(async (ctx) => ({
			blob: await ctx.db.system.get('_storage', storageId),
			upload: await ctx.db.get('imageUploads', imageUploadId)
		}));
		expect(after.blob).toBeNull();
		expect(after.upload).toMatchObject({
			name: 'notes.txt',
			storageId,
			attached: true,
			storageDeletedAt: expect.any(Number)
		});

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts.parts[0]?.prompt?.imageUploads).toEqual([
			{
				imageUploadId,
				name: 'notes.txt',
				mediaType: 'text/plain',
				size: 5,
				storageId
			}
		]);
	});

	it('renaming a thread extends retention without changing its message ordering', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'renamed.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		const lastMessageAt = staleActivityAt();
		await t.run(async (ctx) => {
			await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
			await ctx.db.patch('threadRecords', threadId, { updatedAt: lastMessageAt, lastMessageAt });
		});
		await asUser.mutation(api.threads.renameForLocalCache, { threadId, title: 'Renamed' });
		await expireAttachedStorage(t);
		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.lastMessageAt).toBe(lastMessageAt);
		expect(thread?.updatedAt).toBeGreaterThan(lastMessageAt);
		expect(await t.run((ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
	});

	it('keeps a shared upload while any referencing thread is still active', async () => {
		const t = initConvexTest();
		const { subject, threadId: staleThreadId } = await seedOwnedThread(t);
		const liveThreadId = await seedThreadRecord(t, subject, 'beta');
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'shared.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('threadAttachmentRefs', {
				threadId: staleThreadId,
				imageUploadId
			});
			await ctx.db.insert('threadAttachmentRefs', {
				threadId: liveThreadId,
				imageUploadId
			});
			await ctx.db.patch('threadRecords', staleThreadId, {
				status: 'completed',
				updatedAt: staleActivityAt()
			});
			await ctx.db.patch('threadRecords', liveThreadId, {
				status: 'completed',
				updatedAt: Date.now()
			});
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
		expect(
			(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId)))?.storageDeletedAt
		).toBeUndefined();
	});

	it('keeps bytes during an active run even when updatedAt is old', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'live.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
			await ctx.db.patch('threadRecords', threadId, {
				status: 'running',
				updatedAt: staleActivityAt()
			});
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.order('desc')
				.first();
			if (!run) throw new Error('Missing seed run');
			await ctx.db.patch('runs', run._id, { status: 'running' });
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
	});

	it('does not delete attached storage before associations are migrated', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'pending.txt',
			attached: true
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, {
				status: 'completed',
				updatedAt: staleActivityAt()
			});
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId))).toMatchObject({
			attached: true
		});
	});

	it('scans extra thread refs in a follow-up transaction before deleting', async () => {
		const t = initConvexTest();
		const { subject } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'many-refs.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		const staleThreadIds: Id<'threadRecords'>[] = [];
		for (let index = 0; index < ATTACHMENT_CLEANUP_REF_BATCH; index += 1) {
			staleThreadIds.push(await seedThreadRecord(t, subject, `stale-${index}`));
		}
		const liveThreadId = await seedThreadRecord(t, subject, 'live-shared');
		const threadIds = [...staleThreadIds, liveThreadId].sort();
		await t.run(async (ctx) => {
			for (const threadId of threadIds) {
				await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
				await ctx.db.patch('threadRecords', threadId, {
					status: 'completed',
					updatedAt: threadId === liveThreadId ? Date.now() : staleActivityAt()
				});
			}
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
	});

	it('keeps migrated bytes that still have no thread refs', async () => {
		const t = initConvexTest();
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: 'user_alice',
			name: 'unreferenced.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
		expect(
			(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId)))?.storageDeletedAt
		).toBeUndefined();
	});

	it('deletes after a follow-up scan when every extra ref is stale', async () => {
		const t = initConvexTest();
		const { subject } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'all-stale.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		const threadIds: Id<'threadRecords'>[] = [];
		for (let index = 0; index < ATTACHMENT_CLEANUP_REF_BATCH + 1; index += 1) {
			threadIds.push(await seedThreadRecord(t, subject, `all-stale-${index}`));
		}
		await t.run(async (ctx) => {
			for (const threadId of threadIds) {
				await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
				await ctx.db.patch('threadRecords', threadId, {
					status: 'completed',
					updatedAt: staleActivityAt()
				});
			}
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId))).toMatchObject({
			storageDeletedAt: expect.any(Number)
		});
	});

	it('deletes a full first page of stale refs once the next page is empty', async () => {
		const t = initConvexTest();
		const { subject } = await seedOwnedThread(t);
		const { imageUploadId, storageId } = await insertStoredUpload(t, {
			userId: subject,
			name: 'exact-page.txt',
			attached: true,
			threadRefsMigratedAt: 1
		});
		const threadIds: Id<'threadRecords'>[] = [];
		for (let index = 0; index < ATTACHMENT_CLEANUP_REF_BATCH; index += 1) {
			threadIds.push(await seedThreadRecord(t, subject, `exact-page-${index}`));
		}
		await t.run(async (ctx) => {
			for (const threadId of threadIds) {
				await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
				await ctx.db.patch('threadRecords', threadId, {
					status: 'completed',
					updatedAt: staleActivityAt()
				});
			}
		});

		await expireAttachedStorage(t);

		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
	});

	it.each([0, 1_000])(
		'retains an earlier-scanned thread updated %i ms after the scan starts',
		async (delay) => {
			const t = initConvexTest();
			const { subject } = await seedOwnedThread(t);
			const { imageUploadId, storageId } = await insertStoredUpload(t, {
				userId: subject,
				name: 'race.txt',
				attached: true,
				threadRefsMigratedAt: 1
			});
			const threadIds: Id<'threadRecords'>[] = [];
			for (let index = 0; index < ATTACHMENT_CLEANUP_REF_BATCH + 1; index += 1) {
				threadIds.push(await seedThreadRecord(t, subject, `race-${index}`));
			}
			threadIds.sort();
			await t.run(async (ctx) => {
				for (const threadId of threadIds) {
					await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
					await ctx.db.patch('threadRecords', threadId, {
						status: 'completed',
						updatedAt: staleActivityAt()
					});
				}
			});

			const now = Date.now();
			const firstPage = await t.run(async (ctx) => {
				const upload = await ctx.db.get('imageUploads', imageUploadId);
				if (!upload) throw new Error('Missing upload');
				return await expireUploadIfInactive(ctx, upload, now);
			});
			expect(firstPage.continueFromThreadId).toBeDefined();
			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadIds[0], {
					status: 'completed',
					updatedAt: now + delay
				});
			});
			await t.run(async (ctx) => {
				const upload = await ctx.db.get('imageUploads', imageUploadId);
				if (!upload) throw new Error('Missing upload');
				const result = await expireUploadIfInactive(ctx, upload, now + delay, {
					exclusiveThreadId: firstPage.continueFromThreadId,
					activityFenceAt: firstPage.activityFenceAt
				});
				expect(result.deleted).toBe(0);
			});

			expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
			expect(
				(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId)))?.storageDeletedAt
			).toBeUndefined();
		}
	);
});

describe('imageUploads.cleanupOrphans', () => {
	it('still deletes unattached drafts after a day', async () => {
		const t = initConvexTest();
		const { storageId, imageUploadId } = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['draft']));
			const imageUploadId = await ctx.db.insert('imageUploads', {
				userId: 'user_alice',
				storageId,
				name: 'draft.txt',
				mediaType: 'text/plain',
				size: 5,
				attached: false
			});
			return { storageId, imageUploadId };
		});

		expect(await t.mutation(internal.imageUploads.cleanupOrphans, {})).toBe(0);
		expect(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId))).not.toBeNull();

		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
		try {
			expect(await t.mutation(internal.imageUploads.cleanupOrphans, {})).toBe(1);
		} finally {
			vi.useRealTimers();
		}

		expect(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
	});
});
