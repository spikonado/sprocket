import { describe, expect, it } from 'vitest';
import type { TranscriptCompletionItem } from '@convex/lib/validators';
import { deriveLegacyCompletionWork } from '@convex/lib/legacyTranscriptWork';
import { recordCompletionTranscript } from '@convex/lib/transcriptWrites';
import { beginExecutorJob } from '@convex/lib/toolJobs';
import { createQueuedRun, initConvexTest, seedOwnedThread } from '../test.setup';

describe('legacy completion work', () => {
	it('continues open sections, closes on text, and reuses assignments on retry', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'legacy-work', 'secret');
		const base = { threadId, runId, claimId: 'claim', attemptSeq: 1 };

		const save = async (
			streamId: string,
			items: TranscriptCompletionItem[],
			claimId = base.claimId
		) =>
			t.run(async (ctx) => {
				const args = { ...base, streamId, items, claimId };
				const assignments = await deriveLegacyCompletionWork(ctx, args);
				await recordCompletionTranscript(ctx, { ...args, ...assignments });

				return assignments;
			});

		const firstItems: TranscriptCompletionItem[] = [
			{ type: 'reasoning', id: 'reasoning', text: 'Check files' }
		];

		const first = await save('first', firstItems);
		const firstKey = first.work.ranges[0].sectionKey;

		const second = await save('second', [
			{ type: 'text', id: 'empty', text: ' ' },
			{ type: 'reasoning', id: 'next', text: 'Check more' },
			{ type: 'text', id: 'answer', text: 'Done' },
			{ type: 'reasoning', id: 'last', text: 'One more thing' }
		]);

		expect(second.work.ranges).toEqual([
			{ start: 1, end: 2, sectionKey: firstKey },
			{ start: 3, end: 4, sectionKey: `agent:${runId}:claim:1:section:2` }
		]);
		expect((await save('first', firstItems)).work.ranges).toEqual(first.work.ranges);

		await save('answer-only', [{ type: 'text', id: 'answer2', text: 'Finished' }]);
		await save('empty', [{ type: 'reasoning', id: 'empty2', text: '\n' }]);
		const next = await save('next', [{ type: 'reasoning', id: 'more', text: 'Next' }]);
		expect(next.work.ranges).toEqual([
			{ sectionKey: `agent:${runId}:claim:1:section:3`, start: 0, end: 1 }
		]);

		const resumed = await save(
			'resumed',
			[{ type: 'reasoning', id: 'resumed', text: 'Continue on another claim' }],
			'new-claim'
		);

		expect(resumed.work.ranges).toEqual([
			{ sectionKey: `agent:${runId}:new-claim:1:section:4`, start: 0, end: 1 }
		]);
	});

	it('requires canonical invocation IDs and derives job sections from saved completions', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'legacy-tool', 'secret');
		const base = { threadId, runId, claimId: 'claim', attemptSeq: 1, streamId: 'tool' };

		const call = {
			type: 'tool-call' as const,
			callId: 'call',
			name: 'exec_cmd',
			input: { cmd: 'pwd' }
		};

		await expect(
			t.run((ctx) => deriveLegacyCompletionWork(ctx, { ...base, items: [call] }))
		).rejects.toThrow('Missing canonical tool invocation ID.');

		const job = await t.run(async (ctx) => {
			const args = { ...base, items: [{ ...call, toolInvocationId: 'invocation' }] };
			const assignments = await deriveLegacyCompletionWork(ctx, args);
			await recordCompletionTranscript(ctx, { ...args, ...assignments });
			const run = await ctx.db.get('runs', runId);

			if (!run) throw new Error('Missing run.');

			const jobArgs = {
				run,
				claimId: base.claimId,
				attemptSeq: base.attemptSeq,
				streamId: base.streamId,
				toolInvocationId: 'invocation',
				callId: call.callId,
				kind: 'exec_cmd' as const,
				payload: call.input
			};

			const started = await beginExecutorJob(ctx, jobArgs);
			expect(await beginExecutorJob(ctx, jobArgs)).toEqual(started);

			return await ctx.db.get('executorJobs', started.jobId);
		});

		expect(job).toMatchObject({
			sectionKey: `agent:${runId}:claim:1:section:1`,
			sectionOrdinal: 1
		});
	});
});
