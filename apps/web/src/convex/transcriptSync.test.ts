import { describe, expect, it, vi } from 'vitest';
import type { Infer } from 'convex/values';
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	RegisteredMutation,
	RegisteredQuery
} from 'convex/server';
import type { MutationCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';
import type { workBatch } from './lib/workSections';
import { MEMBERSHIP_MIGRATION } from './lib/transcriptMemberships';
import { commitBatches, indexedMemberships } from './transcriptSections';
import { getParts } from './transcript';

function callHandler<Ref extends FunctionReference<'query' | 'mutation'>>(
	_reference: Ref,
	registered:
		| RegisteredMutation<'public', FunctionArgs<Ref>, Promise<FunctionReturnType<Ref>>>
		| RegisteredQuery<'public', FunctionArgs<Ref>, Promise<FunctionReturnType<Ref>>>,
	ctx: MutationCtx,
	args: FunctionArgs<Ref>
): Promise<FunctionReturnType<Ref>> {
	// SAFETY: Convex registration retains the typed handler as _handler at runtime.
	const { _handler } = registered as typeof registered & {
		_handler: (ctx: MutationCtx, args: FunctionArgs<Ref>) => Promise<FunctionReturnType<Ref>>;
	};
	return _handler(ctx, args);
}

async function fixture(count = 4, items = 1) {
	const t = initConvexTest();
	const owned = await seedOwnedThread(t);
	const { threadId, subject } = owned;
	const ids = await t.run(async (ctx) => {
		const run = await ctx.db.query('runs').unique();
		if (!run) throw new Error('Missing run.');
		await ctx.db.insert('threadTranscriptStates', { threadId, userId: subject, totalParts: count });
		const ids = [];
		for (let number = 0; number < count; number++) {
			ids.push(
				await ctx.db.insert('threadTranscriptParts', {
					threadId,
					userId: subject,
					number,
					runId: run._id,
					sourceKey: `completion:${number}`,
					kind: 'completion',
					completion: {
						items: Array.from({ length: items }, (_, item) => ({
							type: 'text' as const,
							id: `text-${item}`,
							text: 'Text'
						}))
					}
				})
			);
		}
		return ids;
	});
	const batches: Infer<typeof workBatch>[] = Array.from({ length: count }, (_, number) => ({
		expected: { part: number, item: 0 },
		through: { part: number + 1, item: 0 },
		sections: [],
		removed: [],
		memberships: [{ number, processed: items, ranges: [] }]
	}));
	return { t, ...owned, ids, batches };
}

describe('batched transcript indexing', () => {
	it('commits four checkpoints in one transaction without rewriting raw documents', async () => {
		const { t, asUser, threadId, batches } = await fixture();
		const before = await t.run((ctx) => ctx.db.query('threadTranscriptParts').collect());
		expect(
			await asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches })
		).toEqual({ accepted: true, through: { part: 4, item: 0 } });
		expect(await t.run((ctx) => ctx.db.query('threadTranscriptParts').collect())).toEqual(before);
		expect(
			await t.run((ctx) => ctx.db.query('threadTranscriptMemberships').collect())
		).toHaveLength(4);
		expect(
			await asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches })
		).toEqual({ accepted: false, through: { part: 4, item: 0 } });
	});

	it('shares raw and membership reads across partial checkpoints of the same completion', async () => {
		const { asUser, threadId } = await fixture(1, 3);
		const batches: Infer<typeof workBatch>[] = [0, 1, 2].map((item) => ({
			expected: { part: 0, item },
			through: item === 2 ? { part: 1, item: 0 } : { part: 0, item: item + 1 },
			sections: [],
			removed: [],
			memberships: [{ number: 0, processed: item + 1, ranges: [] }]
		}));
		await asUser.run(async (ctx) => {
			const queries = vi.spyOn(ctx.db, 'query');
			expect(
				await callHandler(api.transcriptSections.commitBatches, commitBatches, ctx, {
					threadId,
					batches
				})
			).toEqual({ accepted: true, through: { part: 1, item: 0 } });
			expect(
				queries.mock.calls.filter(([table]) => table === 'threadTranscriptParts')
			).toHaveLength(1);
			expect(
				queries.mock.calls.filter(([table]) => table === 'threadTranscriptMemberships')
			).toHaveLength(1);
		});
		const { parts } = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts[0].work?.processed).toBe(3);
	});

	it('rolls back every checkpoint when a later batch is invalid', async () => {
		const { t, asUser, threadId, batches } = await fixture();
		batches[2].memberships[0].processed = 2;
		await expect(
			asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches })
		).rejects.toThrow('matching membership');
		expect(await t.run((ctx) => ctx.db.query('threadTranscriptMemberships').collect())).toEqual([]);
		expect((await asUser.query(api.transcriptSections.state, { threadId })).through).toEqual({
			part: 0,
			item: 0
		});
	});

	it('rebases a group after another client commits inside its first batch', async () => {
		const { t, asUser, threadId, ids } = await fixture(1, 3);
		const runId = await t.run(async (ctx) => {
			const part = await ctx.db.get('threadTranscriptParts', ids[0]);
			if (!part) throw new Error('Missing part.');
			await ctx.db.patch('threadTranscriptParts', part._id, {
				completion: {
					items: [0, 1, 2].map((item) => ({
						type: 'reasoning' as const,
						id: `reasoning-${item}`,
						text: 'Thinking'
					}))
				}
			});
			return part.runId;
		});
		const batch = (expected: number, processed: number): Infer<typeof workBatch> => ({
			expected: { part: 0, item: expected },
			through: processed === 3 ? { part: 1, item: 0 } : { part: 0, item: processed },
			sections: [
				{
					key: 'work-0-0',
					runId,
					first: { part: 0, item: 0 },
					end: { part: 0, item: processed },
					closed: false,
					provisional: false,
					itemCount: processed,
					pendingTools: 0
				}
			],
			removed: [],
			memberships: [
				{ number: 0, processed, ranges: [{ start: 0, end: processed, sectionKey: 'work-0-0' }] }
			]
		});
		await asUser.mutation(api.transcriptSections.commit, { threadId, batch: batch(0, 1) });
		expect(
			await asUser.mutation(api.transcriptSections.commitBatches, {
				threadId,
				batches: [batch(0, 2), batch(2, 3)]
			})
		).toEqual({ accepted: false, through: { part: 0, item: 1 } });
		expect(
			await asUser.mutation(api.transcriptSections.commitBatches, {
				threadId,
				batches: [batch(1, 2), batch(2, 3)]
			})
		).toEqual({ accepted: true, through: { part: 1, item: 0 } });
		const { parts } = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts[0].work).toEqual({
			processed: 3,
			ranges: [{ start: 0, end: 3, sectionKey: 'work-0-0' }]
		});
	});

	it('rejects noncontiguous, oversized, and foreign groups before committing', async () => {
		const { t, asUser, threadId, batches } = await fixture(5);
		await expect(
			asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches })
		).rejects.toThrow('bounds');
		await expect(
			asUser.mutation(api.transcriptSections.commitBatches, {
				threadId,
				batches: [batches[0], batches[2]]
			})
		).rejects.toThrow('contiguous');
		await expect(
			asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches: [] })
		).rejects.toThrow('Invalid work batch group');
		await expect(
			t
				.withIdentity({ subject: 'other' })
				.mutation(api.transcriptSections.commitBatches, { threadId, batches: batches.slice(0, 4) })
		).rejects.toThrow('Thread not found');
		expect(await t.run((ctx) => ctx.db.query('threadTranscriptMemberships').collect())).toEqual([]);
	});
});

describe('separate transcript memberships', () => {
	it('migrates legacy data online without overwriting newer memberships or raw content', async () => {
		vi.useFakeTimers();
		try {
			const { t, asUser, threadId, ids, batches } = await fixture(2, 2);
			const legacy = { processed: 1, ranges: [] };
			await t.run(async (ctx) => {
				for (const id of ids) await ctx.db.patch('threadTranscriptParts', id, { work: legacy });
			});
			expect(
				await asUser.query(api.transcriptSections.indexedMemberships, { threadId, start: 0 })
			).toEqual([
				{ number: 0, work: legacy },
				{ number: 1, work: legacy }
			]);
			await asUser.mutation(api.transcriptSections.commit, { threadId, batch: batches[0] });
			const before = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
			await t.mutation(internal.migrations.runTranscriptMembershipMigration, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] })).toEqual(
				before
			);
			await t.run(async (ctx) => {
				const parts = await ctx.db.query('threadTranscriptParts').collect();
				expect(parts.every((part) => part.work === undefined)).toBe(true);
				const marker = await ctx.db
					.query('migrationSchedules')
					.withIndex('by_name', (q) => q.eq('name', MEMBERSHIP_MIGRATION))
					.unique();
				expect(marker?.completedAt).toBeDefined();
			});
			await t.mutation(internal.migrations.runTranscriptMembershipMigration, {});
			expect(
				await asUser.query(api.transcriptSections.indexedMemberships, { threadId, start: 0 })
			).toEqual([
				{ number: 0, work: { processed: 2, ranges: [] } },
				{ number: 1, work: legacy }
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps raw and indexed query dependencies disjoint after migration', async () => {
		vi.useFakeTimers();
		try {
			const { t, asUser, threadId, batches } = await fixture();
			await asUser.mutation(api.transcript.ensureMigrated, { threadId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await asUser.mutation(api.transcriptSections.commitBatches, { threadId, batches });
			await asUser.run(async (ctx) => {
				const queries = vi.spyOn(ctx.db, 'query');
				const raw = await callHandler(api.transcript.getParts, getParts, ctx, {
					threadId,
					numbers: [0, 1, 2, 3],
					includeWork: false
				});
				expect(raw.parts.every((part) => part.work === undefined)).toBe(true);
				expect(queries.mock.calls.map(([table]) => table)).toEqual(
					Array(4).fill('threadTranscriptParts')
				);
				queries.mockClear();
				expect(
					await callHandler(api.transcriptSections.indexedMemberships, indexedMemberships, ctx, {
						threadId,
						start: 0
					})
				).toHaveLength(4);
				expect(queries.mock.calls.map(([table]) => table)).toEqual([
					'migrationSchedules',
					'threadTranscriptMemberships'
				]);
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
