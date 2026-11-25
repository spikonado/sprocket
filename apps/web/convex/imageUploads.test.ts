import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { GenericDatabaseWriter, GenericDataModel } from 'convex/server';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

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
			await db.patch('_storage', storageId, { contentType: args.type });
		}

		return storageId;
	});
}

describe('tool images for runs', () => {
	const sha256 = 'a'.repeat(64);

	async function seedRun(t: ReturnType<typeof initConvexTest>, subject: string) {
		const { asUser, threadId } = await seedOwnedThread(t, subject);
		const executionSecret = `secret-${subject}-${Math.random()}`;

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			`tool-image-${Math.random()}`,
			executionSecret
		);

		return { runId, executionSecret, threadId };
	}

	async function upload(
		t: ReturnType<typeof initConvexTest>,
		run: Awaited<ReturnType<typeof seedRun>>
	) {
		const [missing] = await t.mutation(api.imageUploads.toolImageUrlsForRun, {
			runId: run.runId,
			executionSecret: run.executionSecret,
			sha256s: [sha256]
		});

		expect(missing).toHaveProperty('uploadUrl');

		const storageId = await storeUpload(t, { bytes: 'png', type: 'image/png' });

		return await t.mutation(api.imageUploads.registerToolImageForRun, {
			runId: run.runId,
			executionSecret: run.executionSecret,
			storageId,
			sha256
		});
	}

	it('returns the same URL per thread and never shares it across threads', async () => {
		const t = initConvexTest();
		const alice = await seedRun(t, 'user_alice');
		const bob = await seedRun(t, 'user_bob');
		const url = await upload(t, alice);

		expect(
			await t.mutation(api.imageUploads.toolImageUrlsForRun, {
				runId: alice.runId,
				executionSecret: alice.executionSecret,
				sha256s: [sha256, sha256]
			})
		).toEqual([{ sha256, url }]);

		const [bobLookup] = await t.mutation(api.imageUploads.toolImageUrlsForRun, {
			runId: bob.runId,
			executionSecret: bob.executionSecret,
			sha256s: [sha256]
		});

		expect(bobLookup).toHaveProperty('uploadUrl');
	});

	it('keeps the first URL when the same bytes are registered twice', async () => {
		const t = initConvexTest();
		const run = await seedRun(t, 'user_alice');
		const url = await upload(t, run);
		const duplicate = await storeUpload(t, { bytes: 'png', type: 'image/png' });

		expect(
			await t.mutation(api.imageUploads.registerToolImageForRun, {
				runId: run.runId,
				executionSecret: run.executionSecret,
				storageId: duplicate,
				sha256
			})
		).toBe(url);
		expect(await t.run((ctx) => ctx.db.system.get('_storage', duplicate))).toBeNull();
	});
});
