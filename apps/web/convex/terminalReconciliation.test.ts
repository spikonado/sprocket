import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';
import { initConvexTest, seedOwnedThread, type ConvexTestInstance } from './test.setup';

async function reconcileTerminalJobs(t: ConvexTestInstance): Promise<void> {
	const run = await t.run((ctx) => ctx.db.query('runs').first());

	await t.mutation(internal.runCleanup.continueCleanup, {
		runId: run!._id,
		completedAt: run!.completedAt ?? Date.now(),
		jobCursor: -1,
		questionCursor: -1
	});
}

describe('terminal job reconciliation', () => {
	it.each([undefined, false])(
		'preserves historical output with reconciliation marker %s',
		async (marker) => {
			const t = initConvexTest();
			const { threadId, subject } = await seedOwnedThread(t);

			const { jobId, partId } = await t.run(async (ctx) => {
				const run = (await ctx.db.query('runs').first())!;
				const state = (await ctx.db.query('runExecutionStates').first())!;
				await ctx.db.patch('runExecutionStates', state._id, { terminalJobsReconciled: marker });

				const jobId = await ctx.db.insert('executorJobs', {
					threadId,
					runId: run._id,
					kind: 'scrape_url',
					payload: { url: 'https://example.com' },
					status: 'completed',
					result: { url: 'https://example.com', markdown: 'Page', truncated: false },
					enqueuedAt: Date.now(),
					completedAt: Date.now(),
					sequence: 0
				});

				await recordToolTranscript(ctx, {
					threadId,
					userId: subject,
					runId: run._id,
					job: (await ctx.db.get('executorJobs', jobId))!
				});
				await ctx.db.patch('executorJobs', jobId, {
					result: {
						url: 'https://example.com',
						markdown: 'Page',
						summary: 'Page summary',
						images: []
					}
				});

				return { jobId, partId: (await ctx.db.query('threadTranscriptParts').first())!._id };
			});

			await reconcileTerminalJobs(t);
			expect(await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId))).toMatchObject({
				tool: { status: 'completed', output: { markdown: 'Page', truncated: false } }
			});
			expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
				result: { summary: 'Page summary', images: [] }
			});
			expect(await t.run((ctx) => ctx.db.query('runExecutionStates').first())).toMatchObject({
				terminalJobsReconciled: true
			});
		}
	);

	it('preserves the historical section when a settled job lacks section metadata', async () => {
		const t = initConvexTest();
		const { threadId, subject } = await seedOwnedThread(t);

		const part = await t.run(async (ctx) => {
			const run = (await ctx.db.query('runs').first())!;

			const jobId = await ctx.db.insert('executorJobs', {
				threadId,
				runId: run._id,
				kind: 'read_skill',
				payload: { name: 'example' },
				status: 'completed',
				result: 'Skill',
				enqueuedAt: Date.now(),
				completedAt: Date.now(),
				sequence: 0
			});

			await recordToolTranscript(ctx, {
				threadId,
				userId: subject,
				runId: run._id,
				job: (await ctx.db.get('executorJobs', jobId))!
			});
			const part = (await ctx.db.query('threadTranscriptParts').first())!;
			await ctx.db.patch('threadTranscriptParts', part._id, {
				work: { ranges: [], sectionKey: 'work-3-0' }
			});

			return (await ctx.db.get('threadTranscriptParts', part._id))!;
		});

		await reconcileTerminalJobs(t);
		expect(await t.run((ctx) => ctx.db.get('threadTranscriptParts', part._id))).toEqual(part);
		expect(await t.run((ctx) => ctx.db.query('runExecutionStates').first())).toMatchObject({
			terminalJobsReconciled: true
		});
	});

	it('reconciles historical terminal tool results before releasing follow-ups', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);

		const run = await t.run((ctx) =>
			ctx.db
				.query('runs')
				.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
				.first()
		);

		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId: run!._id,
				kind: 'exec_command',
				payload: { cmd: 'true' },
				status: 'claimed',
				enqueuedAt: Date.now(),
				sequence: 0
			})
		);

		await reconcileTerminalJobs(t);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', run!._id))
					.unique()
			)
		).toMatchObject({ terminalJobsReconciled: true });
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			status: 'cancelled'
		});
		expect(await t.run((ctx) => ctx.db.query('threadTranscriptParts').first())).toMatchObject({
			kind: 'tool',
			tool: { status: 'cancelled' }
		});
	});
});
