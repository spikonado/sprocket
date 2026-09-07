import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { HOSTED_THREAD_PAGE_SIZE } from '@convex/lib/hostedThreadList';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

describe('hostedThreads.listPage', () => {
	it('returns a bounded page of only the authenticated user threads', async () => {
		const t = initConvexTest();
		const { asUser, subject } = await seedOwnedThread(t, 'user_alice');
		const ids: Id<'threadRecords'>[] = [];
		for (let index = 0; index < 12; index += 1) {
			const id = await seedThreadRecord(t, subject, `repo-${index}`);
			await t.run(async (ctx) => ctx.db.patch('threadRecords', id, { lastMessageAt: index }));
			ids.push(id);
		}
		const bob = await seedOwnedThread(t, 'user_bob');

		const page = await asUser.query(api.hostedThreads.listPage, {
			paginationOpts: { numItems: 10, cursor: null }
		});
		expect(page.page).toHaveLength(10);
		expect(page.page.some((thread) => thread._id === bob.threadId)).toBe(false);
		expect(page.page.every((thread) => thread.userId === subject)).toBe(true);
		expect(page.selected).toBeNull();
		expect(HOSTED_THREAD_PAGE_SIZE).toBe(40);

		const withOlderSelection = await asUser.query(api.hostedThreads.listPage, {
			paginationOpts: { numItems: 10, cursor: null },
			selectedThreadId: ids[0]
		});
		expect(withOlderSelection.selected?._id).toBe(ids[0]);

		const withForeignSelection = await asUser.query(api.hostedThreads.listPage, {
			paginationOpts: { numItems: 10, cursor: null },
			selectedThreadId: bob.threadId
		});
		expect(withForeignSelection.selected).toBeNull();

		expect(page.isDone).toBe(false);
		const next = await asUser.query(api.hostedThreads.listPage, {
			paginationOpts: { numItems: 10, cursor: page.continueCursor }
		});
		expect(next.page.length).toBeGreaterThan(0);
		expect(next.page.some((thread) => page.page.some((row) => row._id === thread._id))).toBe(false);
	});

	it('refuses unauthenticated reads', async () => {
		const t = initConvexTest();
		await expect(
			t.query(api.hostedThreads.listPage, { paginationOpts: { numItems: 10, cursor: null } })
		).rejects.toThrow('Authentication required.');
	});
});

describe('hostedThreads transcript reads', () => {
	it('projects a bounded message page and refuses other users', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await createQueuedRun(t, asUser, threadId, 'sub-page', 'secret-page', 'Hello');
		const page = await asUser.query(api.hostedThreads.transcriptPage, { threadId, limit: 12 });
		expect(page.stale).toBe(false);
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0]).toMatchObject({
			type: 'prompt',
			text: 'Hello',
			sourceNumbers: [0],
			detailsLoaded: true
		});
		expect(page.nextBefore).toBeUndefined();

		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(bob.query(api.hostedThreads.transcriptPage, { threadId })).rejects.toThrow(
			'Thread not found.'
		);
	});

	it('returns details for one grouped message and watches part identity not only totalParts', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'hosted-watch-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-watch',
			executionSecret,
			'Use a tool'
		);
		const beforeTool = await asUser.query(api.hostedThreads.transcriptWatch, { threadId });
		expect(beforeTool.totalParts).toBe(1);
		expect(beforeTool.latestPartNumber).toBe(0);
		expect(beforeTool.userId).toBeDefined();

		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-watch',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-watch',
			attemptSeq: 1,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId: 'claim-watch',
			runId,
			kind: 'exec_command',
			callId: 'c1',
			payload: { cmd: 'echo hi' },
			executionSecret
		});

		const afterTool = await asUser.query(api.hostedThreads.transcriptWatch, { threadId });
		expect(afterTool.totalParts).toBe(2);
		expect(afterTool.latestPartNumber).toBe(1);
		expect(afterTool.latestPartId).not.toBe(beforeTool.latestPartId);
		expect(afterTool.latestSourceKey).toContain('tool:');
		expect(afterTool.latestRunStatus).toBe('awaiting_executor');

		const page = await asUser.query(api.hostedThreads.transcriptPage, { threadId });
		const response = page.messages.find((message) => message.type === 'response');
		expect(response?.sourceNumbers).toEqual([1]);
		expect(response?.parts[0]).toMatchObject({ type: 'tool-call', callId: 'c1', input: null });

		const details = await asUser.query(api.hostedThreads.transcriptDetails, {
			threadId,
			numbers: response?.sourceNumbers ?? [1]
		});
		expect(details?.detailsLoaded).toBe(true);
		expect(details?.parts[0]).toMatchObject({ type: 'tool-call', callId: 'c1', input: {} });
	});

	it('pages older messages with nextBefore', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		for (let index = 0; index < 4; index += 1) {
			const created = await createQueuedRun(
				t,
				asUser,
				threadId,
				`sub-older-${index}`,
				`secret-older-${index}`,
				`Hello ${index}`
			);
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', created.runId, {
					status: 'completed',
					completedAt: Date.now()
				});
				await ctx.db.patch('threadRecords', threadId, { status: 'completed' });
			});
		}
		const newest = await asUser.query(api.hostedThreads.transcriptPage, {
			threadId,
			limit: 2
		});
		expect(newest.messages).toHaveLength(2);
		expect(newest.nextBefore).toBeDefined();
		const older = await asUser.query(api.hostedThreads.transcriptPage, {
			threadId,
			before: newest.nextBefore,
			limit: 2
		});
		expect(older.messages.length).toBeGreaterThan(0);
		const newestIds = new Set(newest.messages.map((message) => message._id));
		expect(older.messages.every((message) => !newestIds.has(message._id))).toBe(true);
	});

	it('pages a run longer than 300 parts without changing the response id', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-long',
			'secret-long',
			'Long run'
		);
		await t.run(async (ctx) => {
			for (let index = 0; index < 50; index += 1) {
				await appendTranscriptPart(ctx, {
					threadId,
					userId: subject,
					sourceKey: `completion:${runId}:stream-${index}`,
					kind: 'completion',
					runId,
					completion: { items: [{ type: 'text', id: `t${index}`, text: '.' }] }
				});
			}
		});
		for (let batch = 50; batch < 301; batch += 50) {
			const start = batch;
			const end = Math.min(batch + 50, 301);
			await t.run(async (ctx) => {
				for (let index = start; index < end; index += 1) {
					await appendTranscriptPart(ctx, {
						threadId,
						userId: subject,
						sourceKey: `completion:${runId}:stream-${index}`,
						kind: 'completion',
						runId,
						completion: { items: [{ type: 'text', id: `t${index}`, text: '.' }] }
					});
				}
			});
		}
		const newest = await asUser.query(api.hostedThreads.transcriptPage, { threadId, limit: 1 });
		const response = newest.messages.find((message) => message.type === 'response');
		expect(response?._id).toBe(`response:${runId}`);
		expect(response?.sourceNumbers?.length).toBe(100);
		expect(newest.nextBefore).toBeDefined();
		const older = await asUser.query(api.hostedThreads.transcriptPage, {
			threadId,
			before: newest.nextBefore,
			limit: 1
		});
		const olderResponse = older.messages.find((message) => message.type === 'response');
		expect(olderResponse?._id).toBe(response?._id);
		expect(olderResponse?.sourceNumbers?.[0]).toBeLessThan(response?.sourceNumbers?.[0] ?? 0);
	});
});
