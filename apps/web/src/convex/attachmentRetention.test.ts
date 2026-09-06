import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	seedThreadRecord,
	type ConvexTestInstance
} from './test.setup';

const WEEK = 7 * 24 * 60 * 60 * 1_000;

async function attachment(t: ConvexTestInstance, threadId?: Id<'threadRecords'>) {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['file']));
		const imageUploadId = await ctx.db.insert('imageUploads', {
			userId: 'user_alice',
			storageId,
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4,
			attached: threadId !== undefined,
			threadId
		});
		return { storageId, imageUploadId };
	});
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('attachment retention', () => {
	it('assigns the first owning thread and does not transfer ownership when reused', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const otherThreadId = await seedThreadRecord(t, subject, 'other');
		const file = await attachment(t);
		for (const owner of [threadId, otherThreadId]) {
			await insertQueuedRun(t, asUser, {
				submissionId: `attach-${owner}`,
				threadId: owner,
				prompt: 'Read this',
				imageUploadIds: [file.imageUploadId],
				executionSecret: `secret-${owner}`
			});
		}
		expect(await t.run((ctx) => ctx.db.get('imageUploads', file.imageUploadId))).toMatchObject({
			attached: true,
			threadId
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { lastMessageAt: Date.now() - WEEK - 1 });
		});
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(1);
		expect(await t.run((ctx) => ctx.db.system.get('_storage', file.storageId))).toBeNull();
		const parts = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId))
				.take(8)
		);
		expect(parts[0].prompt?.imageUploads[0].imageUploadId).toBe(file.imageUploadId);
	});

	it('uses lastMessageAt alone, including the strict one-week boundary', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const file = await attachment(t, threadId);
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, {
				lastMessageAt: Date.now() - WEEK,
				updatedAt: Date.now(),
				status: 'running'
			});
		});
		await asUser.mutation(api.threads.renameForLocalCache, { threadId, title: 'Recent rename' });
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(0);
		vi.setSystemTime(Date.now() + 1);
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(1);
		expect(await t.run((ctx) => ctx.db.system.get('_storage', file.storageId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get('imageUploads', file.imageUploadId))).toMatchObject({
			threadId,
			name: 'file.txt',
			storageDeletedAt: Date.now()
		});
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(0);
	});

	it('continues through batches and checks current message times', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const files: Awaited<ReturnType<typeof attachment>>[] = [];
		for (let i = 0; i < 20; i++) files.push(await attachment(t, threadId));
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { lastMessageAt: Date.now() - WEEK - 1 });
		});
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(8);
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { lastMessageAt: Date.now() });
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const remaining = await t.run(async (ctx) => {
			const blobs = await Promise.all(
				files.map((file) => ctx.db.system.get('_storage', file.storageId))
			);
			return blobs.filter(Boolean).length;
		});
		expect(remaining).toBe(12);
		vi.setSystemTime(Date.now() + WEEK + 1);
		await t.mutation(internal.imageUploads.cleanupExpired, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		for (const file of files)
			expect(await t.run((ctx) => ctx.db.system.get('_storage', file.storageId))).toBeNull();
	});

	it('waits for an owner backfill and retains the separate one-day draft cleanup', async () => {
		const t = initConvexTest();
		const legacy = await attachment(t);
		const draft = await attachment(t);
		await t.run(async (ctx) => {
			await ctx.db.patch('imageUploads', legacy.imageUploadId, { attached: true });
		});
		vi.setSystemTime(Date.now() + WEEK + 1);
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(0);
		expect(await t.mutation(internal.imageUploads.cleanupOrphans, {})).toBe(1);
		expect(await t.run((ctx) => ctx.db.system.get('_storage', legacy.storageId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.system.get('_storage', draft.storageId))).toBeNull();
	});
});
