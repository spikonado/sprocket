import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread, type ConvexTestInstance } from './test.setup';

async function seedRun(t: ConvexTestInstance, subject: string) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);
	const created = await asUser.mutation(api.agentRuntime.createRun, {
		submissionId: `sub-${Math.random()}`,
		threadId,
		prompt: 'Browse',
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
		executionSecret: `secret-${Math.random()}`
	});
	return { threadId, runId: created.runId, userId: subject };
}

describe('browserSessions', () => {
	it('creates a session row and returns it for the owning user', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_a');

		const id = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});

		const session = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		expect(session).toMatchObject({
			_id: id,
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});
	});

	it('replaces the session on re-upsert, keeping one row per thread', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_b');

		const firstId = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-old'
		});
		const first = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		await new Promise((resolve) => setTimeout(resolve, 5));

		const secondId = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-new'
		});

		expect(secondId).toBe(firstId);
		const session = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		expect(session?.browserbaseSessionId).toBe('bb-new');
		expect(session?.startedAt).toBeGreaterThan(first?.startedAt ?? 0);

		const rows = await t.run(async (ctx) => await ctx.db.query('browserSessions').collect());
		expect(rows.filter((row) => row.threadId === threadId)).toHaveLength(1);
	});

	it('hides the session from other users and other threads', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_c');
		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});

		const other = await seedRun(t, 'user_browser_d');
		await expect(
			t.query(internal.browserSessions.getForThread, { threadId, userId: other.userId })
		).resolves.toBeNull();
		await expect(
			t.query(internal.browserSessions.getForThread, {
				threadId: other.threadId,
				userId: other.userId
			})
		).resolves.toBeNull();
	});
});
