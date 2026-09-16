import { describe, expect, it } from 'vitest';
import type { Infer } from 'convex/values';
import { api } from './_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';
import type { workBatch } from './lib/workSections';
import { UNSUPPORTED_CLIENT_MESSAGE } from './lib/unsupportedClient';

async function fixture() {
	const t = initConvexTest();
	const owned = await seedOwnedThread(t);
	const { threadId, subject } = owned;
	const runId = await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
			.first();
		if (!run) throw new Error('Missing fixture run.');
		await ctx.db.insert('threadTranscriptStates', { threadId, userId: subject, totalParts: 1 });
		await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: subject,
			number: 0,
			sourceKey: 'completion:fixture',
			kind: 'completion',
			runId: run._id,
			completion: {
				items: [
					{
						type: 'reasoning',
						id: 'first',
						text: 'First',
						providerMetadata: { secret: 'ciphertext' }
					},
					{ type: 'text', id: 'text', text: 'Visible' },
					{ type: 'reasoning', id: 'second', text: 'Second' }
				]
			}
		});
		return run._id;
	});
	const batch: Infer<typeof workBatch> = {
		expected: { part: 0, item: 0 },
		through: { part: 1, item: 0 },
		removed: [],
		sections: [0, 2].map((item) => ({
			key: `work-0-${item}`,
			runId,
			first: { part: 0, item },
			end: { part: 0, item: item + 1 },
			closed: item === 0,
			provisional: false,
			itemCount: 1,
			pendingTools: 0
		})),
		memberships: [
			{
				number: 0,
				processed: 3,
				ranges: [
					{ start: 0, end: 1, sectionKey: 'work-0-0' },
					{ start: 2, end: 3, sectionKey: 'work-0-2' }
				]
			}
		]
	};
	return { t, ...owned, runId, batch };
}

describe('transcript work assignments', () => {
	it.each(['queued', 'running', 'completed', 'failed', 'cancelled', undefined] as const)(
		'resolves the active run for thread status %s, including unmigrated threads',
		async (status) => {
			const { t, asUser, threadId, runId } = await fixture();
			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadId, { status });
				await ctx.db.patch('runs', runId, { status: status ?? 'running' });
			});
			const state = await asUser.query(api.transcriptSections.state, { threadId });
			expect(state.activeRunId).toBe(
				status === undefined || status === 'queued' || status === 'running' ? runId : null
			);
		}
	);

	it('returns the committed checkpoint on acceptance and conflict without changing legacy responses', async () => {
		const { asUser, threadId, batch } = await fixture();
		expect(
			await asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch,
				includeCheckpoint: true
			})
		).toEqual({ accepted: true, through: batch.through });
		expect(
			await asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch,
				includeCheckpoint: true
			})
		).toEqual({ accepted: false, through: batch.through });
		expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch })).toBe(false);
	});

	it.each([false, true])(
		'resumes canonical tool relocation with a partial checkpoint: %s',
		async (partial) => {
			const { t, asUser, threadId, runId, subject, batch: initial } = await fixture();
			await asUser.mutation(api.transcriptSections.commit, { threadId, batch: initial });
			await t.run(async (ctx) => {
				const state = await ctx.db.query('threadTranscriptStates').unique();
				if (!state) throw new Error('Missing fixture state.');
				await ctx.db.patch('threadTranscriptStates', state._id, { totalParts: 5 });
				for (const number of [1, 2])
					await ctx.db.insert('threadTranscriptParts', {
						threadId,
						userId: subject,
						runId,
						number,
						sourceKey: `tool:${number}`,
						kind: 'tool',
						tool: { callId: 'call', name: 'read', status: number === 1 ? 'started' : 'completed' }
					});
				await ctx.db.insert('threadTranscriptParts', {
					threadId,
					userId: subject,
					runId,
					number: 3,
					sourceKey: 'completion:call',
					kind: 'completion',
					completion: {
						items: [
							{ type: 'text', id: 'progress', text: 'Progress before the next tool call' },
							{ type: 'tool-call', callId: 'call', name: 'read', input: {} }
						]
					}
				});
				await ctx.db.insert('threadTranscriptParts', {
					threadId,
					userId: subject,
					runId,
					number: 4,
					sourceKey: 'completion:final',
					kind: 'completion',
					completion: {
						items: [{ type: 'text', id: 'final', text: 'Previously unreachable history' }]
					}
				});
			});
			const old = initial.sections[1];
			for (const number of [1, 2])
				await asUser.mutation(api.transcriptSections.commit, {
					threadId,
					batch: {
						expected: { part: number, item: 0 },
						through: { part: number + 1, item: 0 },
						removed: [],
						sections: [{ ...old, itemCount: 2, pendingTools: number === 1 ? 1 : 0 }],
						memberships: [{ number, processed: 1, ranges: [], sectionKey: old.key }]
					}
				});
			const moved: Infer<typeof workBatch> = {
				expected: { part: 3, item: partial ? 1 : 0 },
				through: { part: 4, item: 0 },
				removed: [],
				sections: [
					{ ...old, closed: true },
					{ ...old, key: 'work-3-1', first: { part: 3, item: 1 }, end: { part: 3, item: 2 } }
				],
				memberships: [
					{ number: 1, processed: 1, ranges: [], sectionKey: 'work-3-1' },
					{ number: 2, processed: 1, ranges: [], sectionKey: 'work-3-1' },
					{ number: 3, processed: 2, ranges: [{ start: 1, end: 2, sectionKey: 'work-3-1' }] }
				]
			};
			if (partial)
				await asUser.mutation(api.transcriptSections.commit, {
					threadId,
					batch: {
						expected: { part: 3, item: 0 },
						through: moved.expected,
						removed: [],
						sections: [{ ...old, closed: true, itemCount: 2 }],
						memberships: [{ number: 3, processed: 1, ranges: [] }]
					}
				});
			const replaceTool = async (callId: string, name: string) => {
				await t.run(async (ctx) => {
					const part = await ctx.db
						.query('threadTranscriptParts')
						.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId).eq('number', 1))
						.unique();
					if (!part) throw new Error('Missing tool event.');
					await ctx.db.patch('threadTranscriptParts', part._id, {
						tool: { callId, name, status: 'started' }
					});
				});
			};
			for (const [callId, name] of [
				['unrelated', 'read'],
				['call', 'unrelated']
			]) {
				await replaceTool(callId, name);
				await expect(
					asUser.mutation(api.transcriptSections.commit, { threadId, batch: moved })
				).rejects.toThrow('canonical call');
			}
			await replaceTool('call', 'read');
			const unrelated = structuredClone(moved);
			unrelated.memberships[0].sectionKey = 'work-0-0';
			await expect(
				asUser.mutation(api.transcriptSections.commit, { threadId, batch: unrelated })
			).rejects.toThrow('canonical call');
			expect((await asUser.query(api.transcriptSections.state, { threadId })).through).toEqual(
				moved.expected
			);
			expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch: moved })).toBe(
				true
			);
			expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch: moved })).toBe(
				false
			);
			const rows = (await asUser.query(api.transcriptSections.sections, { threadId, after: '' }))
				.rows;
			expect(rows.find((row) => row.key === old.key)?.linkedParts).toBe(0);
			expect(rows.find((row) => row.key === 'work-3-1')?.linkedParts).toBe(2);
			await asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch: {
					expected: moved.through,
					through: { part: 5, item: 0 },
					removed: [],
					sections: [{ ...moved.sections[1], closed: true }],
					memberships: [{ number: 4, processed: 1, ranges: [] }]
				}
			});
			expect((await asUser.query(api.transcriptSections.state, { threadId })).through.part).toBe(5);
			const parts = await asUser.query(api.transcriptSections.memberships, { threadId, start: 0 });
			expect(parts.map((part) => part.work?.processed)).toEqual([3, 1, 1, 2, 1]);
		}
	);

	it('atomically persists Rust assignments without changing raw completion items', async () => {
		const { t, asUser, threadId, batch } = await fixture();
		expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch })).toBe(true);
		const rows = await asUser.query(api.transcriptSections.sections, { threadId, after: '' });
		expect(rows.rows).toHaveLength(2);
		expect(JSON.stringify(rows)).not.toContain('ciphertext');
		expect(rows.rows.every((row) => !('revision' in row))).toBe(true);
		const parts = await t.run(async (ctx) => await ctx.db.query('threadTranscriptParts').collect());
		expect(parts[0].completion?.items).toHaveLength(3);
		expect(parts[0].completion?.items[0].providerMetadata).toEqual({ secret: 'ciphertext' });
		expect(parts[0].work?.ranges[0]).toEqual({ start: 0, end: 1, sectionKey: rows.rows[0].key });
		expect((await asUser.query(api.transcriptSections.state, { threadId })).through).toEqual(
			batch.through
		);
	});

	it('rejects another user and leaves no partial assignments after validation fails', async () => {
		const { t, asUser, threadId, batch } = await fixture();
		await expect(
			t
				.withIdentity({ subject: 'other' })
				.mutation(api.transcriptSections.commit, { threadId, batch })
		).rejects.toThrow('Thread not found');
		batch.memberships[0].ranges[0].end = 2;
		await expect(
			asUser.mutation(api.transcriptSections.commit, { threadId, batch })
		).rejects.toThrow('non-work item');
		expect(
			(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows
		).toEqual([]);
		expect((await asUser.query(api.transcriptSections.state, { threadId })).through).toEqual({
			part: 0,
			item: 0
		});
	});

	it('returns a CAS conflict on retry without changing existing assignments', async () => {
		const { asUser, threadId, batch } = await fixture();
		expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch })).toBe(true);
		batch.sections[0].itemCount = 30;
		expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch })).toBe(false);
		expect(
			(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows[0]
				.itemCount
		).toBe(1);
	});

	it.each(['overlap', 'duplicate', 'nonfinite', 'checkpoint'])(
		'rejects malformed %s assignments',
		async (kind) => {
			const { asUser, threadId, batch } = await fixture();
			if (kind === 'overlap') batch.memberships[0].ranges[1].start = 0;
			if (kind === 'duplicate') batch.sections.push(batch.sections[0]);
			if (kind === 'nonfinite') batch.sections[0].startedAt = Infinity;
			if (kind === 'checkpoint') batch.memberships[0].processed = 2;
			await expect(
				asUser.mutation(api.transcriptSections.commit, { threadId, batch })
			).rejects.toThrow();
			expect(
				(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows
			).toEqual([]);
		}
	);

	it('rejects section membership from another run even within the same thread', async () => {
		const { t, asUser, threadId, runId, batch } = await fixture();
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			if (!run) throw new Error('Missing fixture run.');
			const { _id, _creationTime, ...body } = run;
			const other = await ctx.db.insert('runs', {
				...body,
				submissionId: `${_id}-${_creationTime}-other`
			});
			await ctx.db.insert('threadTranscriptWorkSections', {
				threadId,
				linkedParts: 0,
				...batch.sections[0],
				key: 'work-0-9',
				first: { part: 0, item: 9 },
				end: { part: 0, item: 10 },
				runId: other
			});
		});
		batch.memberships[0].ranges[0].sectionKey = 'work-0-9';
		await expect(
			asUser.mutation(api.transcriptSections.commit, { threadId, batch })
		).rejects.toThrow('another run');
	});

	it('finalizes closed work only after its run is terminal', async () => {
		const { t, asUser, threadId, runId, batch } = await fixture();
		await asUser.mutation(api.transcriptSections.commit, { threadId, batch });
		const finished = {
			...batch,
			expected: batch.through,
			finishedRunId: runId,
			memberships: [],
			sections: batch.sections.map((row) => ({ ...row, closed: true }))
		};
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { status: 'running' });
		});
		await expect(
			asUser.mutation(api.transcriptSections.commit, { threadId, batch: finished })
		).rejects.toThrow('finalization');
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { status: 'completed' });
		});
		expect(
			await asUser.mutation(api.transcriptSections.commit, { threadId, batch: finished })
		).toBe(true);
		expect(
			await asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch: finished,
				includeCheckpoint: true
			})
		).toEqual({ accepted: true, through: batch.through });
	});

	it.each([0, 1])(
		'finalizes stored sections despite replay differences with %s pending tools',
		async (pendingTools) => {
			const { t, asUser, threadId, runId, batch } = await fixture();
			batch.sections[0].startedAt = 100;
			batch.sections[0].completedAt = 200;
			batch.sections[1].startedAt = 300;
			batch.sections[1].pendingTools = pendingTools;
			batch.sections[1].completedAt = pendingTools === 0 ? 400 : undefined;
			await asUser.mutation(api.transcriptSections.commit, { threadId, batch });
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', runId, { status: 'completed' });
			});
			const before = await asUser.query(api.transcriptSections.sections, { threadId, after: '' });
			const finished = {
				...batch,
				expected: batch.through,
				finishedRunId: runId,
				memberships: [],
				sections: batch.sections.map((row) => ({
					...row,
					closed: true,
					pendingTools: 0,
					itemCount: row.itemCount + 1,
					end: batch.through,
					startedAt: 50,
					completedAt: 500
				}))
			};
			for (let retry = 0; retry < 2; retry++) {
				expect(
					await asUser.mutation(api.transcriptSections.commit, { threadId, batch: finished })
				).toBe(true);
				expect(
					(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows
				).toEqual(before.rows.map((row) => ({ ...row, closed: true, pendingTools: 0 })));
			}
			expect((await asUser.query(api.transcriptSections.state, { threadId })).through).toEqual(
				batch.through
			);
		}
	);

	it('ignores replay-only section keys without creating sections or rewriting memberships', async () => {
		const { t, asUser, threadId, runId, batch } = await fixture();
		await asUser.mutation(api.transcriptSections.commit, { threadId, batch });
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { status: 'completed' });
		});
		const memberships = await asUser.query(api.transcriptSections.memberships, {
			threadId,
			start: 0
		});
		const finished = {
			...batch,
			expected: batch.through,
			finishedRunId: runId,
			memberships: [],
			sections: [
				{ ...batch.sections[1], closed: true },
				{
					...batch.sections[0],
					key: 'work-0-1',
					first: { part: 0, item: 1 },
					end: { part: 0, item: 2 }
				}
			]
		};
		expect(
			await asUser.mutation(api.transcriptSections.commit, { threadId, batch: finished })
		).toBe(true);
		expect(
			(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows.map(
				(row) => row.key
			)
		).toEqual(['work-0-0', 'work-0-2']);
		expect(await asUser.query(api.transcriptSections.memberships, { threadId, start: 0 })).toEqual(
			memberships
		);
	});

	it('rejects finalizing a section stored for another run atomically', async () => {
		const { t, asUser, threadId, runId, batch } = await fixture();
		await asUser.mutation(api.transcriptSections.commit, { threadId, batch });
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			if (!run) throw new Error('Missing fixture run.');
			const { _id, _creationTime, ...body } = run;
			const other = await ctx.db.insert('runs', {
				...body,
				submissionId: `${_id}-${_creationTime}-other`
			});
			const row = await ctx.db
				.query('threadTranscriptWorkSections')
				.withIndex('by_threadId_and_key', (q) => q.eq('threadId', threadId).eq('key', 'work-0-0'))
				.unique();
			if (!row) throw new Error('Missing fixture section.');
			await ctx.db.patch('threadTranscriptWorkSections', row._id, { runId: other });
			await ctx.db.patch('runs', runId, { status: 'completed' });
		});
		const before = await asUser.query(api.transcriptSections.sections, { threadId, after: '' });
		await expect(
			asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch: {
					...batch,
					expected: batch.through,
					finishedRunId: runId,
					memberships: [],
					sections: batch.sections.toReversed().map((row) => ({ ...row, closed: true }))
				}
			})
		).rejects.toThrow('Invalid finished work section');
		expect(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).toEqual(
			before
		);
	});

	it('requires an explicit upgrade for the old completion write contract', async () => {
		const { asUser, runId } = await fixture();
		await expect(
			asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
				runId,
				executionSecret: 'unused',
				claimId: 'unused',
				attemptSeq: 1,
				streamId: 'old',
				items: []
			})
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);
		await expect(
			asUser.action(api.agentRuntime.createGatewayRun, {
				submissionId: 'old',
				prompt: 'old',
				storageIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				executionSecret: 'unused'
			})
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);
	});

	it('relocates every provisional tool reference atomically before removing its section', async () => {
		const { t, asUser, threadId, runId, subject } = await fixture();
		await t.run(async (ctx) => {
			const parts = await ctx.db.query('threadTranscriptParts').collect();
			await ctx.db.delete('threadTranscriptParts', parts[0]._id);
			const state = await ctx.db.query('threadTranscriptStates').unique();
			if (!state) throw new Error('Missing fixture state.');
			await ctx.db.patch('threadTranscriptStates', state._id, { totalParts: 3 });
			for (const number of [0, 1])
				await ctx.db.insert('threadTranscriptParts', {
					threadId,
					userId: subject,
					runId,
					number,
					sourceKey: `tool:${number}`,
					kind: 'tool',
					tool: { callId: 'call', name: 'read', status: number === 0 ? 'started' : 'completed' }
				});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: subject,
				runId,
				number: 2,
				sourceKey: 'completion:call',
				kind: 'completion',
				completion: { items: [{ type: 'tool-call', callId: 'call', name: 'read', input: {} }] }
			});
		});
		const provisional = {
			key: 'work-0-0',
			runId,
			first: { part: 0, item: 0 },
			end: { part: 0, item: 1 },
			closed: true,
			provisional: true,
			itemCount: 1,
			pendingTools: 1
		};
		for (const number of [0, 1]) {
			await asUser.mutation(api.transcriptSections.commit, {
				threadId,
				batch: {
					expected: { part: number, item: 0 },
					through: { part: number + 1, item: 0 },
					removed: [],
					sections: [{ ...provisional, pendingTools: number === 0 ? 1 : 0 }],
					memberships: [{ number, processed: 1, ranges: [], sectionKey: provisional.key }]
				}
			});
		}
		expect(
			(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows[0]
				.linkedParts
		).toBe(2);
		const batch: Infer<typeof workBatch> = {
			expected: { part: 2, item: 0 },
			through: { part: 3, item: 0 },
			removed: [provisional.key],
			sections: [
				{
					...provisional,
					key: 'work-2-0',
					first: { part: 2, item: 0 },
					end: { part: 2, item: 1 },
					closed: false,
					provisional: false,
					pendingTools: 0
				}
			],
			memberships: [
				{ number: 0, processed: 1, ranges: [], sectionKey: 'work-2-0' },
				{ number: 2, processed: 1, ranges: [{ start: 0, end: 1, sectionKey: 'work-2-0' }] }
			]
		};
		await expect(
			asUser.mutation(api.transcriptSections.commit, { threadId, batch })
		).rejects.toThrow('referenced');
		expect(
			(await asUser.query(api.transcriptSections.sections, { threadId, after: '' })).rows[0]
				.linkedParts
		).toBe(2);
		batch.memberships.push({ number: 1, processed: 1, ranges: [], sectionKey: 'work-2-0' });
		expect(await asUser.mutation(api.transcriptSections.commit, { threadId, batch })).toBe(true);
		const rows = (await asUser.query(api.transcriptSections.sections, { threadId, after: '' }))
			.rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 'work-2-0', linkedParts: 2 });
		const links = await asUser.query(api.transcriptSections.memberships, { threadId, start: 0 });
		expect(links.slice(0, 2).map((part) => part.work)).toEqual([
			{ processed: 1, ranges: [], sectionKey: 'work-2-0' },
			{ processed: 1, ranges: [], sectionKey: 'work-2-0' }
		]);
	});
});
