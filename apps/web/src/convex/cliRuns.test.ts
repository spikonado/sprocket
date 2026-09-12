import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread, createQueuedRun } from './test.setup';

describe('CLI run reads', () => {
	beforeEach(() => vi.stubEnv('MODEL_GATEWAY_URL', 'https://gateway.example.test'));
	afterEach(() => vi.unstubAllEnvs());
	it('keeps run output account-scoped and rejects invalid cursors', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'cli-read', 'cli-read-secret');
		const args = { runId, afterPart: -1 };
		await expect(
			t.withIdentity({ subject: 'other-user' }).query(api.cliRuns.snapshot, args)
		).rejects.toThrow('Run not found');
		await expect(asUser.query(api.cliRuns.snapshot, { ...args, afterPart: 0.5 })).rejects.toThrow(
			'Invalid transcript cursor'
		);
		const snapshot = await asUser.query(api.cliRuns.snapshot, args);
		expect(snapshot.runId).toBe(runId);
		expect(snapshot.parts.every((part) => part.runId === runId)).toBe(true);
	});

	it('reports the exact active run without silently choosing another thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId, repositoryKey } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'cli-context',
			'cli-context-secret'
		);
		const context = await asUser.query(api.cliRuns.context, { threadId });
		expect(context.thread).toMatchObject({ repositoryKey, activeRunId: runId });
		await expect(
			t.withIdentity({ subject: 'other-user' }).query(api.cliRuns.context, { threadId })
		).rejects.toThrow('Thread not found');
	});
});
