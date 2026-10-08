import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

const sessionId = '00000000-0000-4000-8000-000000000001';

const snapshot = {
	command: 'build',
	workdir: '/workspace',
	machineId: 'machine-one',
	result: { success: false, running: true, timedOut: false, output: 'first\n' }
};

function eventBytes(sequence: number, channel: 'stdout' | 'stderr', output: string) {
	return new TextEncoder().encode(
		`${JSON.stringify({ sequence, timestampMs: 123, channel, bytes: [...new TextEncoder().encode(output)] })}\n`
	);
}

describe('durable thread command sessions', () => {
	it('replays ordered logs and preserves completed results across sync retries', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const bytes = new Uint8Array([
			...eventBytes(0, 'stdout', 'first\n'),
			...eventBytes(1, 'stderr', 'last\n')
		]);

		const split = 17;

		const args = {
			threadId,
			sessionId,
			snapshot,
			chunks: [
				{ offset: 0, bytes: bytes.slice(0, split).buffer },
				{ offset: split, bytes: bytes.slice(split).buffer }
			]
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

		const result = await asUser.query(api.commands.get, { threadId, sessionId });

		expect(result).toMatchObject({
			machineId: 'machine-one',
			eventsBytes: bytes.byteLength,
			result: completed.result
		});

		const logs = await asUser.query(api.commands.getLogChunks, {
			threadId,
			sessionId,
			offset: 3
		});

		expect(logs.map((log) => log.offset)).toEqual([0, split]);
		expect(logs.map((log) => new TextDecoder().decode(log.bytes)).join('')).toBe(
			new TextDecoder().decode(bytes)
		);

		const remaining = await asUser.query(api.commands.getLogChunks, {
			threadId,
			sessionId,
			offset: split
		});

		expect(remaining.map((log) => log.offset)).toEqual([split]);
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
			other.query(api.commands.getLogChunks, { threadId, sessionId, offset: 0 })
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
		const bytes = eventBytes(0, 'stdout', 'saved').buffer;
		await asUser.mutation(api.commands.sync, {
			threadId,
			sessionId,
			snapshot,
			chunks: [{ offset: 0, bytes }]
		});
		await expect(
			asUser.mutation(api.commands.sync, {
				threadId,
				sessionId,
				snapshot,
				chunks: [{ offset: bytes.byteLength + 1, bytes }]
			})
		).rejects.toThrow('out of order');
		await expect(
			asUser.mutation(api.commands.sync, {
				threadId,
				sessionId,
				snapshot,
				chunks: [{ offset: 0, bytes: eventBytes(0, 'stdout', 'other').buffer }]
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
