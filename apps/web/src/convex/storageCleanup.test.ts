import { afterEach, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest } from '@convex/test.setup';

afterEach(() => vi.useRealTimers());

it('collects lost uploads and callback results, preserving registered files and recent uploads', async () => {
	vi.useFakeTimers();
	const t = initConvexTest();
	const old = await t.run(async (ctx) => {
		const lostUpload = await ctx.storage.store(new Blob(['lost upload']));
		const lostResult = await ctx.storage.store(new Blob(['lost result']));
		const attachment = await ctx.storage.store(new Blob(['attached']));
		await ctx.db.insert('imageUploads', {
			userId: 'owner',
			storageId: attachment,
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 8,
			attached: true
		});
		return { lostUpload, lostResult, attachment };
	});
	vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1_000);
	const recent = await t.run((ctx) => ctx.storage.store(new Blob(['recent'])));
	expect(await t.mutation(internal.storageCleanup.cleanupUnregistered, {})).toBe(2);
	await t.run(async (ctx) => {
		expect(await ctx.db.system.get('_storage', old.lostUpload)).toBeNull();
		expect(await ctx.db.system.get('_storage', old.lostResult)).toBeNull();
		expect(await ctx.db.system.get('_storage', old.attachment)).not.toBeNull();
		expect(await ctx.db.system.get('_storage', recent)).not.toBeNull();
	});
});
