import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { BLOB_DELETE_DELAY_MS } from '@convex/lib/files';
import {
	finishDueScheduledFunctions,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	seedTiers,
	type ConvexTestInstance
} from './test.setup';

const sha256 = 'ab'.repeat(32);

const upload = { name: 'robot.png', mediaType: 'image/png', size: 5, sha256 };

const fetchMock = vi.fn<(request: Request) => Promise<Response>>(
	async () => new Response(null, { status: 204 })
);

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('CONVEX_CLOUD_URL', 'https://happy-otter-123.convex.cloud');
	vi.stubEnv('R2_ACCOUNT_ID', 'account');
	vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
	vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
	vi.stubEnv('R2_BUCKET', 'bucket');
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fetchMock.mockClear();
});

async function seed(t: ConvexTestInstance) {
	await seedTiers(t);

	return await seedOwnedThread(t);
}

async function storedBytes(t: ConvexTestInstance, userId: string) {
	return await t.run(async (ctx) => {
		const usage = await ctx.db
			.query('storageUsage')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		return usage?.bytes;
	});
}

async function send(
	t: ConvexTestInstance,
	owned: Awaited<ReturnType<typeof seed>>,
	fileId: Id<'files'>
) {
	await insertQueuedRun(t, owned.asUser, {
		submissionId: `send-${fileId}`,
		threadId: owned.threadId,
		prompt: 'Read this',
		fileIds: [fileId],
		executionSecret: `secret-${fileId}`
	});
}

function createUpload(owned: Awaited<ReturnType<typeof seed>>) {
	return owned.asUser.mutation(api.files.createUpload, upload);
}

async function blobPath(t: ConvexTestInstance, fileId: Id<'files'>) {
	const file = await t.run((ctx) => ctx.db.get('files', fileId));

	return `/bucket/happy-otter-123/files/${file!.userId}/${file!.blobId}`;
}

describe('files', () => {
	it('returns the same normalized metadata that the transcript will use', async () => {
		const t = initConvexTest();
		const owned = await seed(t);

		const { file } = await owned.asUser.mutation(api.files.createUpload, {
			...upload,
			name: ' robot.png ',
			mediaType: ' IMAGE/PNG '
		});

		const stored = await t.run((ctx) => ctx.db.get('files', file.fileId));
		expect(file).toMatchObject({ name: 'robot.png', mediaType: 'image/png', size: 5 });
		expect(stored).toMatchObject({ name: file.name, mediaType: file.mediaType, size: file.size });
	});

	it('presigns a PUT that R2 checks against the declared length and hash', async () => {
		const t = initConvexTest();
		const owned = await seed(t);
		const { file, upload: put } = await createUpload(owned);

		const url = new URL(put!.url);
		expect(url.origin).toBe('https://account.r2.cloudflarestorage.com');
		expect(url.pathname).toBe(await blobPath(t, file.fileId));
		expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
			'content-length;host;x-amz-checksum-sha256'
		);
		expect(put!.headers).toEqual({
			'content-length': '5',
			'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64')
		});
		expect(await storedBytes(t, owned.subject)).toBe(5);
	});

	it('stores bytes once per user and skips uploads of sent files', async () => {
		const t = initConvexTest();
		const owned = await seed(t);
		const { file: first } = await createUpload(owned);

		expect((await createUpload(owned)).upload).not.toBeNull();
		await send(t, owned, first.fileId);
		expect((await createUpload(owned)).upload).toBeNull();
		expect(await storedBytes(t, owned.subject)).toBe(5);
	});

	it('refuses uploads over the plan storage limit', async () => {
		const t = initConvexTest();
		const owned = await seed(t);
		await t.run(async (ctx) => {
			const free = await ctx.db
				.query('tiers')
				.withIndex('by_tierId', (query) => query.eq('tierId', 'free'))
				.unique();

			await ctx.db.patch('tiers', free!._id, { storageBytes: 8 });
		});
		await createUpload(owned);

		await expect(
			owned.asUser.mutation(api.files.createUpload, { ...upload, sha256: 'cd'.repeat(32) })
		).rejects.toThrow('File storage limit reached.');
	});

	it('deletes the blob after its upload URLs expire once its last file is discarded', async () => {
		const t = initConvexTest();
		const owned = await seed(t);
		const { file: first } = await createUpload(owned);
		const { file: second } = await createUpload(owned);
		const path = await blobPath(t, second.fileId);

		expect(await owned.asUser.mutation(api.files.discard, { fileId: first.fileId })).toBe(true);
		await owned.asUser.mutation(api.files.discard, { fileId: second.fileId });
		expect(await storedBytes(t, owned.subject)).toBe(0);

		const { file: reupload } = await createUpload(owned);
		expect(await blobPath(t, reupload.fileId)).not.toBe(path);

		vi.advanceTimersByTime(BLOB_DELETE_DELAY_MS);
		await finishDueScheduledFunctions(t);
		expect(
			fetchMock.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])
		).toEqual([['DELETE', path]]);
	});

	it('sweeps drafts older than a day and keeps sent files', async () => {
		const t = initConvexTest();
		const owned = await seed(t);
		const { file: draft } = await createUpload(owned);

		const { file: sent } = await owned.asUser.mutation(api.files.createUpload, {
			...upload,
			sha256: 'cd'.repeat(32)
		});

		await send(t, owned, sent.fileId);

		vi.advanceTimersByTime(25 * 60 * 60 * 1_000);
		await t.mutation(internal.files.cleanupDrafts, {});
		await finishDueScheduledFunctions(t);

		expect(await t.run((ctx) => ctx.db.get('files', draft.fileId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get('files', sent.fileId))).not.toBeNull();
		expect(await storedBytes(t, owned.subject)).toBe(5);
	});
});
