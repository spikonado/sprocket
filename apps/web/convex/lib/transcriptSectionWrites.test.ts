import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from '@convex/test.setup';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { writeToolSectionData, writeCompletionSectionData } from './transcriptSectionWrites';

describe('section tool counts', () => {
	it('counts pending calls once across results, completions, retries, and reused call ids', async () => {
		const t = initConvexTest();
		const { threadId, subject } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const run = await ctx.db.query('runs').unique();

			if (!run) throw new Error('Missing run');
			const common = { threadId, userId: subject, runId: run._id };

			for (const [index, name] of ['exec_cmd', 'exec_cmd', 'poll_cmd'].entries()) {
				const toolInvocationId = `invocation-${index}`;

				const { part } = await appendTranscriptPart(ctx, {
					...common,
					sourceKey: `tool:${toolInvocationId}:started`,
					kind: 'tool',
					tool: { toolInvocationId, callId: 'reused', name, status: 'started' },
					work: { ranges: [], sectionKey: 'work' }
				});

				const args = {
					part,
					sectionKey: 'work',
					sectionOrdinal: 1,
					toolInvocationId,
					started: true
				};

				await writeToolSectionData(ctx, args);
				await writeToolSectionData(ctx, args);

				if (index === 0) {
					const result = await appendTranscriptPart(ctx, {
						...common,
						sourceKey: `tool:${toolInvocationId}:finished`,
						kind: 'tool',
						tool: {
							toolInvocationId,
							callId: 'reused',
							name,
							status: 'failed',
							output: { error: 'failed' }
						},
						work: { ranges: [], sectionKey: 'work' }
					});

					await writeToolSectionData(ctx, { ...args, part: result.part, started: false });
				}

				const completion = await appendTranscriptPart(ctx, {
					...common,
					sourceKey: `completion:${index}`,
					kind: 'completion',
					completion: {
						streamId: String(index),
						items: [{ type: 'tool-call', callId: 'reused', name, input: {} }]
					},
					work: {
						ranges: [{ start: 0, end: 1, sectionKey: 'work' }],
						toolInvocations: [{ item: 0, toolInvocationId }]
					}
				});

				const completionArgs = {
					part: completion.part,
					work: completion.part.work,
					sections: [{ sectionKey: 'work', sectionOrdinal: 1, closed: false }],
					representedCallIds: new Set(['reused'])
				};

				await writeCompletionSectionData(ctx, completionArgs);
				await writeCompletionSectionData(ctx, completionArgs);
			}
		});
		expect(
			await t.run((ctx) => ctx.db.query('threadTranscriptWorkSections').unique())
		).toMatchObject({ toolCounts: { exec_cmd: 2, poll_cmd: 1 }, pendingTools: 2 });
	});

	it('backfills started and completion calls once using invocation and legacy job lookups', async () => {
		const t = initConvexTest();
		const { threadId, subject } = await seedOwnedThread(t);

		await t.run(async (ctx) => {
			const run = await ctx.db.query('runs').unique();

			if (!run) throw new Error('Missing run');
			const common = { threadId, userId: subject, runId: run._id };

			for (const callId of ['current', 'legacy']) {
				const toolInvocationId = `invocation-${callId}`;

				await ctx.db.insert('executorJobs', {
					threadId,
					runId: run._id,
					kind: 'exec_cmd',
					payload: { cmd: 'true' },
					callId,
					toolInvocationId,
					status: 'claimed',
					enqueuedAt: 1,
					sequence: 0
				});

				const started = await appendTranscriptPart(ctx, {
					...common,
					sourceKey: `tool:${toolInvocationId}:started`,
					kind: 'tool',
					tool: { callId, toolInvocationId, name: 'exec_cmd', status: 'started' },
					work: { ranges: [], sectionKey: 'work' }
				});

				await writeToolSectionData(ctx, {
					part: started.part,
					sectionKey: 'work',
					sectionOrdinal: 1,
					toolInvocationId,
					started: true
				});

				const completion = await appendTranscriptPart(ctx, {
					...common,
					sourceKey: `completion:${callId}`,
					kind: 'completion',
					completion: {
						items: [{ type: 'tool-call', callId, name: 'exec_cmd', input: {} }]
					},
					work: {
						ranges: [{ start: 0, end: 1, sectionKey: 'work' }],
						toolInvocations: callId === 'current' ? [{ item: 0, toolInvocationId }] : []
					}
				});

				await writeCompletionSectionData(ctx, {
					part: completion.part,
					work: completion.part.work,
					sections: [{ sectionKey: 'work', sectionOrdinal: 1, closed: false }],
					representedCallIds: new Set([callId])
				});
			}

			const section = await ctx.db.query('threadTranscriptWorkSections').unique();

			if (!section) throw new Error('Missing section');
			await ctx.db.patch('threadTranscriptWorkSections', section._id, { toolCounts: undefined });

			for await (const entry of ctx.db.query('threadTranscriptMemberships')) {
				await ctx.db.patch('threadTranscriptMemberships', entry._id, { countedThrough: undefined });
			}
		});

		const batch = { cursor: null, batchSize: 100 };
		await t.mutation(internal.migrations.initializeSectionToolCounts, batch);
		await t.mutation(internal.migrations.backfillSectionToolCounts, batch);
		await t.mutation(internal.migrations.backfillSectionToolCounts, batch);

		expect(
			await t.run((ctx) => ctx.db.query('threadTranscriptWorkSections').unique())
		).toMatchObject({ toolCounts: { exec_cmd: 2 }, pendingTools: 2 });
	});

	it('backfills large ranges in bounded chunks and replays without recounting', async () => {
		vi.useFakeTimers();

		try {
			const t = initConvexTest();
			const { threadId, subject } = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				const run = await ctx.db.query('runs').unique();

				if (!run) throw new Error('Missing run');

				for (const key of ['work', 'empty']) {
					await ctx.db.insert('threadTranscriptWorkSections', {
						threadId,
						runId: run._id,
						key,
						first: { part: 0, item: 0 },
						end: { part: 1, item: 1 },
						closed: true,
						provisional: false,
						itemCount: 1,
						pendingTools: 0,
						sectionOrdinal: 1,
						displayOrder: key
					});
				}

				const { part } = await appendTranscriptPart(ctx, {
					threadId,
					userId: subject,
					runId: run._id,
					sourceKey: 'historical',
					kind: 'completion',
					completion: {
						streamId: 'historical',
						items: Array.from({ length: 130 }, (_, index) => ({
							type: 'tool-call' as const,
							callId: `call-${index}`,
							name: 'web_search',
							input: {}
						}))
					},
					work: { ranges: [{ start: 0, end: 130, sectionKey: 'work' }] }
				});

				await ctx.db.insert('threadTranscriptMemberships', {
					threadId,
					partNumber: part.number,
					runId: run._id,
					entryKey: 'range:0:0:work',
					start: 0,
					end: 130,
					sectionKey: 'work',
					sectionOrdinal: 1,
					closed: true
				});
			});
			const batch = { cursor: null, batchSize: 1 };
			await t.mutation(internal.migrations.initializeSectionToolCounts, {
				...batch,
				batchSize: 100
			});
			await t.mutation(internal.migrations.backfillSectionToolCounts, batch);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.backfillSectionToolCounts, batch);
			const sections = await t.run((ctx) => ctx.db.query('threadTranscriptWorkSections').collect());
			expect(sections.find((section) => section.key === 'work')?.toolCounts).toEqual({
				web_search: 130
			});
			expect(sections.find((section) => section.key === 'empty')?.toolCounts).toEqual({});
		} finally {
			vi.useRealTimers();
		}
	});
});
