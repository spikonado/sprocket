import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

const sessionId = '00000000-0000-4000-8000-000000000001';

const snapshot = {
	command: 'build',
	workdir: '/workspace',
	machineId: 'machine-one',
	result: { success: false, running: true, timedOut: false, output: 'first\n' }
};

describe('durable thread command sessions', () => {
	it('replays ordered logs and completed results to a later run on the same thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const bytes = new TextEncoder().encode('first\nlast\n').buffer;

		const args = {
			threadId,
			sessionId,
			snapshot,
			chunks: [{ stream: 'output' as const, offset: 0, bytes }]
		};

		await asUser.mutation(api.commands.sync, args);
		await asUser.mutation(api.commands.sync, args);

		const completed = {
			...snapshot,
			result: {
				success: true,
				running: false,
				timedOut: false,
				output: 'first\nlast\n',
				exitCode: 0
			}
		};

		await asUser.mutation(api.commands.sync, {
			threadId,
			sessionId,
			snapshot: completed,
			chunks: []
		});
		await asUser.mutation(api.commands.sync, args);

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'later-machine',
			'later-secret',
			'query old command'
		);

		const result = await t.query(api.commands.getForRun, {
			runId,
			executionSecret: 'later-secret',
			sessionId
		});

		expect(result).toMatchObject({
			machineId: 'machine-one',
			outputBytes: bytes.byteLength,
			result: completed.result
		});

		const logs = await asUser.query(api.commands.getLogChunks, {
			threadId,
			sessionId,
			stream: 'output',
			offset: 3
		});

		expect(logs).toHaveLength(1);
		expect(new TextDecoder().decode(logs[0].bytes)).toBe('first\nlast\n');
	});

	it('isolates users and threads for metadata and log access', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.commands.sync, { threadId, sessionId, snapshot, chunks: [] });
		const { asUser: other } = await seedOwnedThread(t, 'other-user');
		await expect(other.query(api.commands.get, { threadId, sessionId })).rejects.toThrow(
			'Thread not found'
		);
		await expect(
			other.query(api.commands.getLogChunks, { threadId, sessionId, stream: 'output', offset: 0 })
		).rejects.toThrow('Thread not found');
		await expect(
			other.mutation(api.commands.sync, { threadId, sessionId, snapshot, chunks: [] })
		).rejects.toThrow('Thread not found');
		const { threadId: anotherThread } = await seedOwnedThread(t);
		expect(await asUser.query(api.commands.get, { threadId: anotherThread, sessionId })).toBeNull();
	});

	it('rejects gaps, changed retries, and a different originating machine', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const bytes = new TextEncoder().encode('saved').buffer;
		await asUser.mutation(api.commands.sync, {
			threadId,
			sessionId,
			snapshot,
			chunks: [{ stream: 'output', offset: 0, bytes }]
		});
		await expect(
			asUser.mutation(api.commands.sync, {
				threadId,
				sessionId,
				snapshot,
				chunks: [{ stream: 'output', offset: 99, bytes }]
			})
		).rejects.toThrow('out of order');
		await expect(
			asUser.mutation(api.commands.sync, {
				threadId,
				sessionId,
				snapshot,
				chunks: [{ stream: 'output', offset: 0, bytes: new TextEncoder().encode('other').buffer }]
			})
		).rejects.toThrow('does not match');
		await expect(
			asUser.mutation(api.commands.sync, {
				threadId,
				sessionId,
				snapshot: { ...snapshot, machineId: 'machine-two' },
				chunks: []
			})
		).rejects.toThrow('identity cannot change');
	});
});
