import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

describe('legacy compat backfill migrations', () => {
	it('unsets transcript state workThrough', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const stateId = await t.run((ctx) =>
			ctx.db.insert('threadTranscriptStates', {
				threadId,
				userId: 'user_alice',
				totalParts: 2,
				workThrough: { part: 1, item: 2 }
			})
		);

		await t.mutation(internal.migrations.removeTranscriptStateWorkThrough, oneBatch);

		expect(await t.run((ctx) => ctx.db.get('threadTranscriptStates', stateId))).toMatchObject({
			totalParts: 2
		});
		expect(
			(await t.run((ctx) => ctx.db.get('threadTranscriptStates', stateId)))?.workThrough
		).toBeUndefined();
	});

	it('drops userEmail from stored mandate setup payloads', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing test fixture.');
			return run._id;
		});
		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'mandate_setup',
				toolInvocationId: 'test-invocation-email',
				payload: {
					amountCap: '10.00',
					currency: 'USD',
					frequency: 'one_time',
					scope: 'any',
					description: 'Legacy mandate',
					userEmail: 'old@example.com'
				},
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				sequence: 0
			})
		);

		await t.mutation(internal.migrations.removeMandateSetupUserEmail, oneBatch);

		const job = await t.run((ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.payload).toEqual({
			amountCap: '10.00',
			currency: 'USD',
			frequency: 'one_time',
			scope: 'any',
			description: 'Legacy mandate'
		});
	});

	it('normalizes stored scrape results to the current shape', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing test fixture.');
			return run._id;
		});
		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'scrape_url',
				toolInvocationId: 'test-invocation-scrape',
				payload: { url: 'https://example.com' },
				result: { url: 'https://example.com', markdown: '# Hi', truncated: true },
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				sequence: 0
			})
		);

		await t.mutation(internal.migrations.normalizeScrapeUrlResults, oneBatch);

		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			result: {
				url: 'https://example.com',
				markdown: '# Hi',
				summary: 'No summary was returned for this page.',
				images: []
			}
		});
	});

	it('backfills missing job invocation ids and migrates tool part jobIds', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing test fixture.');
			return run._id;
		});
		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'exec_command',
				callId: 'call-1',
				payload: { cmd: 'echo hi' },
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				sequence: 0
			})
		);
		const partId = await t.run((ctx) =>
			ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'tool:legacy',
				kind: 'tool',
				runId,
				tool: { jobId, callId: 'call-1', name: 'exec_command', status: 'completed' },
				work: { ranges: [] }
			})
		);

		await t.mutation(internal.migrations.backfillExecutorJobToolInvocationId, oneBatch);
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			toolInvocationId: jobId
		});

		await t.mutation(internal.migrations.migrateToolPartJobIds, oneBatch);
		const part = await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId));
		expect(part?.tool).toMatchObject({ toolInvocationId: jobId, callId: 'call-1' });
		expect(part?.tool).not.toHaveProperty('jobId');
	});

	it('normalizes missing completion timing to null', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing test fixture.');
			return run._id;
		});
		const partId = await t.run((ctx) =>
			ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'completion:run:stream',
				kind: 'completion',
				runId,
				completion: {
					streamId: 'stream',
					items: [{ type: 'text', id: 't1', text: 'hi' }]
				},
				work: { ranges: [] }
			})
		);

		await t.mutation(internal.migrations.normalizeTranscriptCompletionTiming, oneBatch);

		expect((await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId)))?.completion).toEqual(
			{
				streamId: 'stream',
				items: [{ type: 'text', id: 't1', text: 'hi', startedAt: null, completedAt: null }]
			}
		);
	});

	it('strips stored imageUploadId from prompt attachments', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const ids = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['file'], { type: 'text/plain' }));
			const uploadId = await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 4,
				attached: true,
				threadId
			});
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.first();
			if (!run) throw new Error('Missing fixture run');
			const partId = await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: subject,
				number: 0,
				sourceKey: `prompt:${run._id}`,
				kind: 'prompt',
				runId: run._id,
				prompt: {
					text: 'Read',
					imageUploads: [
						{
							storageId,
							name: 'file.txt',
							mediaType: 'text/plain',
							size: 4,
							imageUploadId: uploadId
						}
					]
				},
				work: { ranges: [] }
			});
			return { partId };
		});

		await t.mutation(internal.migrations.stripStoredAttachmentImageUploadIds, oneBatch);

		const part = await t.run((ctx) => ctx.db.get('threadTranscriptParts', ids.partId));
		expect(part?.prompt?.imageUploads[0]).not.toHaveProperty('imageUploadId');
		expect(part?.prompt?.imageUploads[0]).toMatchObject({ name: 'file.txt' });
	});

	it('converts run-ID handoff cutoffs to part numbers', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const firstSecret = 'handoff-convert-first';
		const first = await createQueuedRun(t, asUser, threadId, 'handoff-convert', firstSecret, 'Hi');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, {
				contextSummary: 'Old summary',
				contextSummaryThroughRunId: first.runId
			});
		});
		const expected = await t.run(async (ctx) => {
			const parts = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_runId_and_number', (query) =>
					query.eq('threadId', threadId).eq('runId', first.runId)
				)
				.collect();
			return Math.max(...parts.map((part) => part.number));
		});

		await t.mutation(internal.migrations.convertContextHandoffCutoffs, oneBatch);

		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummary: 'Old summary',
			contextSummaryThroughPartNumber: expected
		});
		expect(
			(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.contextSummaryThroughRunId
		).toBeUndefined();
	});

	it('records completion through the automatic schedule', async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await t.run((ctx) =>
				ctx.db.insert('threadTranscriptStates', {
					threadId,
					userId: 'user_alice',
					totalParts: 0,
					workThrough: { part: 0, item: 0 }
				})
			);

			await t.mutation(internal.migrations.runLegacyCompatBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runLegacyCompatBackfillAutomatically, {});

			const schedule = await t.run((ctx) =>
				ctx.db.query('migrationSchedules').withIndex('by_name').unique()
			);
			expect(schedule).toMatchObject({ name: 'legacy-compat-backfill-2026-09' });
			expect(schedule?.completedAt).toBeDefined();
			const states = await t.run((ctx) =>
				ctx.db.query('threadTranscriptStates').withIndex('by_threadId').collect()
			);
			expect(states.every((state) => state.workThrough === undefined)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
