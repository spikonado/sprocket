import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { GenericDatabaseWriter, GenericDataModel } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

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
