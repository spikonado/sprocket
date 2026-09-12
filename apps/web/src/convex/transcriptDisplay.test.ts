import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { initConvexTest, seedOwnedThread } from './test.setup';

afterEach(() => vi.useRealTimers());

async function fixture() {
	vi.useFakeTimers();
	const t = initConvexTest();
	const { asUser, threadId, subject } = await seedOwnedThread(t);
	const runId = await t.run(async (ctx) => {
		const run = await ctx.db.query('runs').first();
		if (!run) throw new Error('Missing fixture run.');
		return run._id;
	});
	const add = async (
		part: Pick<Doc<'threadTranscriptParts'>, 'kind' | 'completion' | 'tool' | 'prompt'>,
		sourceKey: string
	) =>
		await t.run(
			async (ctx) =>
				await appendTranscriptPart(ctx, { threadId, userId: subject, runId, sourceKey, ...part })
		);
	const finish = () => t.finishAllScheduledFunctions(vi.runAllTimers);
	return { t, asUser, threadId, runId, add, finish };
}

describe('display history', () => {
	it('pages past 2,000 hidden items as one timed row and loads only the requested details', async () => {
		const { asUser, threadId, add, finish } = await fixture();
		await add({ kind: 'prompt', prompt: { text: 'Earlier prompt', imageUploads: [] } }, 'prompt');
		await add(
			{
				kind: 'completion',
				completion: {
					streamId: 'work',
					items: Array.from({ length: 2_000 }, (_, i) => ({
						type: 'reasoning',
						id: `r${i}`,
						text: `Private reasoning ${i}`,
						startedAt: i * 1_000,
						completedAt: (i + 1) * 1_000,
						providerMetadata: { secret: 'provider ciphertext' }
					}))
				}
			},
			'work'
		);
		await add(
			{
				kind: 'completion',
				completion: {
					streamId: 'answer',
					items: [{ type: 'text', id: 'answer', text: 'Final answer', startedAt: 2_000_000 }]
				}
			},
			'answer'
		);
		await finish();
		const latest = await asUser.query(api.transcriptDisplay.page, { threadId, limit: 2 });
		expect(latest.indexing).toBe(false);
		expect(latest.rows.map((row) => row.kind)).toEqual(['work', 'text']);
		const work = latest.rows[0];
		expect(work).toMatchObject({
			itemCount: 2_000,
			startedAt: 0,
			completedAt: 2_000_000,
			closed: true
		});
		expect(JSON.stringify(latest).length).toBeLessThan(1_500);
		expect(JSON.stringify(latest)).not.toContain('Private reasoning');
		const earlier = await asUser.query(api.transcriptDisplay.page, {
			threadId,
			before: latest.nextBefore,
			limit: 2
		});
		expect(earlier.rows.map((row) => row.text)).toEqual(['Earlier prompt']);
		const details = await asUser.query(api.transcriptDisplay.details, { threadId, rowId: work.id });
		expect(details.parts).toHaveLength(5);
		expect(JSON.stringify(details)).not.toContain('ciphertext');
		const next = await asUser.query(api.transcriptDisplay.details, {
			threadId,
			rowId: work.id,
			after: details.nextAfter
		});
		expect(next.parts[0]).toMatchObject({ text: 'Private reasoning 5' });
		const last = await asUser.query(api.transcriptDisplay.details, {
			threadId,
			rowId: work.id,
			latest: true
		});
		expect(last.parts.at(-1)).toMatchObject({ text: 'Private reasoning 1999' });
		expect(last.nextAfter).toBeUndefined();
		const previous = await asUser.query(api.transcriptDisplay.details, {
			threadId,
			rowId: work.id,
			before: last.previousBefore
		});
		expect(previous.parts.at(-1)).toMatchObject({ text: 'Private reasoning 1994' });
		expect(
			(await asUser.query(api.transcriptDisplay.page, { threadId, limit: 2 })).rows[0]
		).toEqual(work);
	}, 60_000);

	it('retains orphan tool results and reconciles their sections when canonical order arrives', async () => {
		const { asUser, threadId, add, finish } = await fixture();
		await add(
			{ kind: 'tool', tool: { callId: 'call', name: 'exec_command', status: 'started' } },
			'started'
		);
		await add(
			{
				kind: 'tool',
				tool: {
					callId: 'call',
					name: 'exec_command',
					status: 'completed',
					output: { output: 'tool output' }
				}
			},
			'finished'
		);
		await finish();
		const provisional = await asUser.query(api.transcriptDisplay.page, { threadId });
		expect(provisional.rows).toHaveLength(1);
		expect(provisional.rows[0].provisional).toBe(true);
		await add(
			{
				kind: 'completion',
				completion: {
					streamId: 'turn',
					items: [
						{ type: 'text', id: 'first', text: 'Before the tool' },
						{
							type: 'tool-call',
							callId: 'call',
							name: 'exec_command',
							input: { cmd: 'pwd' },
							startedAt: 100
						},
						{ type: 'text', id: 'last', text: 'After the tool' }
					]
				}
			},
			'completion'
		);
		await finish();
		const page = await asUser.query(api.transcriptDisplay.page, {
			threadId,
			changesAfter: provisional.changesCursor
		});
		expect(page.rows.map((row) => row.kind)).toEqual(['text', 'work', 'text']);
		expect(page.changes).toContainEqual({ id: provisional.rows[0].id, row: null });
		const detail = await asUser.query(api.transcriptDisplay.details, {
			threadId,
			rowId: page.rows[1].id
		});
		expect(detail.parts).toMatchObject([
			{ type: 'tool-call', callId: 'call', input: { cmd: 'pwd' }, startedAt: 100 },
			{ type: 'tool-result', callId: 'call', output: { output: 'tool output' } }
		]);
	});

	it('reports late results outside the latest page and keeps command sessions running across text breaks', async () => {
		const { asUser, threadId, add, finish } = await fixture();
		await add(
			{
				kind: 'tool',
				tool: {
					callId: 'exec',
					name: 'exec_command',
					status: 'completed',
					output: { sessionId: 'session', running: true }
				}
			},
			'exec-result'
		);
		await add(
			{
				kind: 'completion',
				completion: {
					items: [
						{
							type: 'tool-call',
							callId: 'exec',
							name: 'exec_command',
							input: { cmd: 'long-command' }
						},
						...Array.from({ length: 20 }, (_, index) => ({
							type: 'text' as const,
							id: `text-${index}`,
							text: `Text ${index}`
						}))
					]
				}
			},
			'exec-call'
		);
		await finish();
		const first = await asUser.query(api.transcriptDisplay.page, { threadId, limit: 40 });
		const work = first.rows[0];
		expect(work).toMatchObject({ kind: 'work', closed: true, pendingTools: 1 });
		await add(
			{
				kind: 'tool',
				tool: {
					callId: 'monitor',
					name: 'write_stdin',
					status: 'completed',
					output: { running: false }
				}
			},
			'monitor-result'
		);
		await add(
			{
				kind: 'completion',
				completion: {
					items: [
						{
							type: 'tool-call',
							callId: 'monitor',
							name: 'write_stdin',
							input: { sessionId: 'session' }
						}
					]
				}
			},
			'monitor-call'
		);
		await finish();
		const latest = await asUser.query(api.transcriptDisplay.page, {
			threadId,
			limit: 12,
			changesAfter: first.changesCursor
		});
		expect(latest.rows.some((row) => row.id === work.id)).toBe(false);
		expect(latest.changes).toContainEqual(
			expect.objectContaining({ id: work.id, row: expect.objectContaining({ pendingTools: 0 }) })
		);
		const detail = await asUser.query(api.transcriptDisplay.details, { threadId, rowId: work.id });
		expect(detail.parts[1]).toMatchObject({ type: 'tool-result', output: { running: false } });
	});

	it('drains more than 64 changes at one revision without skipping sections', async () => {
		const { asUser, threadId, add, finish } = await fixture();
		await add({ kind: 'prompt', prompt: { text: 'Start', imageUploads: [] } }, 'prompt');
		await finish();
		const initial = await asUser.query(api.transcriptDisplay.page, { threadId });
		await add(
			{
				kind: 'completion',
				completion: {
					items: Array.from({ length: 70 }, (_, index) => [
						{
							type: 'tool-call' as const,
							callId: `call-${index}`,
							name: 'exec_command',
							input: { cmd: 'pwd' }
						},
						{ type: 'text' as const, id: `text-${index}`, text: 'Next section' }
					]).flat()
				}
			},
			'many-sections'
		);
		await finish();
		const first = await asUser.query(api.transcriptDisplay.page, {
			threadId,
			changesAfter: initial.changesCursor
		});
		expect(first.changes).toHaveLength(64);
		expect(first.moreChanges).toBe(true);
		const next = await asUser.query(api.transcriptDisplay.page, {
			threadId,
			changesAfter: first.changesCursor
		});
		expect(next.moreChanges).toBe(false);
		expect(new Set([...first.changes, ...next.changes].map((change) => change.id)).size).toBe(70);
	});

	it('resumes a canceled index schedule and never exposes partial detail batches', async () => {
		const { t, asUser, threadId, add, finish } = await fixture();
		await add(
			{
				kind: 'completion',
				completion: { items: [{ type: 'reasoning', id: 'first', text: 'First' }] }
			},
			'first'
		);
		await finish();
		const initial = await asUser.query(api.transcriptDisplay.page, { threadId });
		await add(
			{
				kind: 'completion',
				completion: {
					items: Array.from({ length: 150 }, (_, index) => ({
						type: 'reasoning',
						id: `next-${index}`,
						text: 'Next'
					}))
				}
			},
			'next'
		);
		await t.run(async (ctx) => {
			const state = await ctx.db.query('threadTranscriptDisplayStates').first();
			if (!state?.scheduledId) throw new Error('Missing schedule');
			await ctx.scheduler.cancel(state.scheduledId);
		});
		await t.mutation(internal.transcriptDisplay.backfill, { threadId });
		expect(
			await asUser.query(api.transcriptDisplay.details, { threadId, rowId: initial.rows[0].id })
		).toMatchObject({ indexing: true, parts: [] });
		await t.run(async (ctx) => {
			const state = await ctx.db.query('threadTranscriptDisplayStates').first();
			if (!state?.scheduledId) throw new Error('Missing continuation');
			await ctx.scheduler.cancel(state.scheduledId);
		});
		await asUser.mutation(api.transcriptDisplay.prepare, { threadId });
		await finish();
		const completed = await asUser.query(api.transcriptDisplay.page, { threadId });
		expect(completed.rows).toHaveLength(1);
		expect(completed.rows[0].itemCount).toBe(151);
	});

	it('backfills existing parts and rejects another user or a section from another thread', async () => {
		const { t, asUser, threadId, runId } = await fixture();
		await t.run(async (ctx) => {
			await ctx.db.insert('threadTranscriptStates', {
				threadId,
				userId: 'user_alice',
				totalParts: 1
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				runId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'legacy',
				kind: 'completion',
				completion: { items: [{ type: 'reasoning', id: 'legacy', text: 'Saved reasoning' }] }
			});
		});
		await asUser.mutation(api.transcriptDisplay.prepare, { threadId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const page = await asUser.query(api.transcriptDisplay.page, { threadId });
		expect(page.rows).toHaveLength(1);
		expect(page.rows[0].startedAt).toBeUndefined();
		await expect(
			t.withIdentity({ subject: 'other' }).query(api.transcriptDisplay.page, { threadId })
		).rejects.toThrow('Thread not found');
		const other = await seedOwnedThread(t);
		await expect(
			asUser.query(api.transcriptDisplay.details, {
				threadId: other.threadId,
				rowId: page.rows[0].id
			})
		).rejects.toThrow('Work section not found');
	});

	it('acknowledges a streamed completion only after indexing all its items', async () => {
		const { asUser, threadId, runId, add, finish } = await fixture();
		const stream = { runId, streamId: 'stream' };
		await add(
			{
				kind: 'completion',
				completion: {
					streamId: stream.streamId,
					items: Array.from({ length: 150 }, (_, index) => ({
						type: 'reasoning',
						id: `reason-${index}`,
						text: 'Reasoning',
						startedAt: 100,
						completedAt: 200
					}))
				}
			},
			'stream'
		);
		expect(
			(await asUser.query(api.transcriptDisplay.page, { threadId, streams: [stream] }))
				.persistedStreams
		).toEqual([]);
		await finish();
		expect(
			(await asUser.query(api.transcriptDisplay.page, { threadId, streams: [stream] }))
				.persistedStreams
		).toEqual([stream]);
	});
});
