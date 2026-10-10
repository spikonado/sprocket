import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

describe('legacy compat backfill migrations', () => {
	it('reconciles historical terminal tool results before releasing follow-ups', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);

		const run = await t.run((ctx) =>
			ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
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

		await t.mutation(internal.migrations.reconcileLegacyTerminalJobs, oneBatch);
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
		await t.mutation(internal.migrations.backfillCommandToolInputs, oneBatch);
		const part = await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId));
		expect(part?.tool).toMatchObject({
			toolInvocationId: jobId,
			callId: 'call-1',
			input: { cmd: 'echo hi' }
		});
		expect(part?.tool).not.toHaveProperty('jobId');
	});

	it('backfills command inputs by run and invocation without pairing reused call ids', async () => {
		const t = initConvexTest();
		const { threadId, subject } = await seedOwnedThread(t);

		const cases = [
			{ kind: 'exec_cmd', payload: { cmd: 'echo current' } },
			{ kind: 'exec_command', payload: { cmd: 'echo legacy' } },
			{ kind: 'control_cmd', payload: { sessionId: 'current', action: 'terminate' } },
			{
				kind: 'control_command',
				payload: { sessionId: 'legacy', action: 'write', chars: 'hi' },
				expected: { sessionId: 'legacy', action: 'write' }
			},
			{
				kind: 'poll_cmd',
				payload: { sessionId: 'current', yieldTimeMs: 0 },
				expected: { sessionId: 'current' }
			},
			{ kind: 'poll_command', payload: { sessionId: 'legacy' } },
			{
				kind: 'write_stdin',
				payload: { sessionId: 'oldest', chars: 'hi', terminate: false },
				expected: { sessionId: 'oldest' }
			}
		] as const;

		const partIds = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.unique();

			if (!run) throw new Error('Missing test fixture.');
			const ids = [];

			for (const [index, { kind, payload }] of cases.entries()) {
				const toolInvocationId = `command-${index}`;
				await ctx.db.insert('executorJobs', {
					threadId,
					runId: run._id,
					kind,
					payload,
					callId: 'reused-call',
					toolInvocationId,
					status: 'failed',
					enqueuedAt: 1,
					sequence: index
				});
				ids.push(
					await ctx.db.insert('threadTranscriptParts', {
						threadId,
						userId: subject,
						runId: run._id,
						number: index,
						sourceKey: `tool:${toolInvocationId}:finished`,
						kind: 'tool',
						tool: { toolInvocationId, name: kind, callId: 'reused-call', status: 'failed' },
						work: { ranges: [] }
					})
				);
			}

			return ids;
		});

		await t.mutation(internal.migrations.backfillCommandToolInputs, oneBatch);
		await t.mutation(internal.migrations.backfillCommandToolInputs, oneBatch);

		for (const [index, partId] of partIds.entries()) {
			expect(
				(await t.run((ctx) => ctx.db.get('threadTranscriptParts', partId)))?.tool?.input
			).toEqual('expected' in cases[index] ? cases[index].expected : cases[index].payload);
		}
	});

	it('keeps supplied inputs and leaves unmatched or noncommand history unknown', async () => {
		const t = initConvexTest();
		const { threadId, subject } = await seedOwnedThread(t);
		const { threadId: otherThreadId } = await seedOwnedThread(t, 'other-user');

		const partIds = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.unique();

			if (!run) throw new Error('Missing test fixture.');

			await ctx.db.insert('executorJobs', {
				threadId,
				runId: run._id,
				kind: 'poll_cmd',
				payload: { sessionId: 'retained' },
				callId: 'reused-call',
				toolInvocationId: 'retained',
				status: 'completed',
				enqueuedAt: 1,
				sequence: 0
			});

			const tools = [
				{ name: 'poll_cmd', toolInvocationId: 'retained', input: { sessionId: 'supplied' } },
				{ name: 'poll_cmd', toolInvocationId: 'retained', input: null },
				{ name: 'poll_cmd', toolInvocationId: 'missing' },
				{ name: 'read_file', toolInvocationId: 'retained' },
				{ name: 'control_cmd', toolInvocationId: 'retained' },
				{ name: 'poll_cmd', toolInvocationId: 'retained' }
			];

			const ids = [];

			for (const [index, tool] of tools.entries()) {
				ids.push(
					await ctx.db.insert('threadTranscriptParts', {
						threadId: index === 5 ? otherThreadId : threadId,
						userId: subject,
						runId: run._id,
						number: index,
						sourceKey: `tool:test-${index}`,
						kind: 'tool',
						tool: { ...tool, callId: 'reused-call', status: 'started' },
						work: { ranges: [] }
					})
				);
			}

			return ids;
		});

		await t.mutation(internal.migrations.backfillCommandToolInputs, oneBatch);

		const parts = await t.run(async (ctx) =>
			Promise.all(partIds.map((id) => ctx.db.get('threadTranscriptParts', id)))
		);

		expect(parts.map((part) => part?.tool?.input)).toEqual([
			{ sessionId: 'supplied' },
			null,
			undefined,
			undefined,
			undefined,
			undefined
		]);
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

	it('unsets section linkedParts', async () => {
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

		const sectionId = await t.run((ctx) =>
			ctx.db.insert('threadTranscriptWorkSections', {
				threadId,
				key: 'section',
				runId,
				first: { part: 0, item: 0 },
				end: { part: 0, item: 1 },
				closed: true,
				provisional: false,
				itemCount: 1,
				pendingTools: 0,
				sectionOrdinal: 1,
				displayOrder: '0000000000000001:run:000000000001',
				linkedParts: 1
			})
		);

		await t.mutation(internal.migrations.removeSectionLinkedParts, oneBatch);

		const section = await t.run((ctx) => ctx.db.get('threadTranscriptWorkSections', sectionId));
		expect(section).toMatchObject({ sectionOrdinal: 1 });
		expect(section).not.toHaveProperty('linkedParts');
	});

	it('unsets artifact registry rekey targets', async () => {
		const t = initConvexTest();

		const registryId = await t.run((ctx) =>
			ctx.db.insert('artifactRegistries', {
				userId: 'user_alice',
				repositoryKey: 'repository-a',
				revision: 2,
				rekeyTo: 'repository-b'
			})
		);

		await t.mutation(internal.migrations.removeArtifactRegistryRekeyTargets, oneBatch);

		const registry = await t.run((ctx) => ctx.db.get('artifactRegistries', registryId));
		expect(registry).toMatchObject({ repositoryKey: 'repository-a', revision: 2 });
		expect(registry).not.toHaveProperty('rekeyTo');
	});

	it('backfills command inputs after the previous schedule completed', async () => {
		vi.useFakeTimers();

		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);

			const commandPartId = await t.run(async (ctx) => {
				const run = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
					.unique();

				if (!run) throw new Error('Missing test fixture.');
				await ctx.db.insert('executorJobs', {
					threadId,
					runId: run._id,
					kind: 'poll_cmd',
					payload: { sessionId: 'scheduled' },
					toolInvocationId: 'scheduled-command',
					status: 'failed',
					enqueuedAt: 1,
					sequence: 0
				});

				return await ctx.db.insert('threadTranscriptParts', {
					threadId,
					userId: run.userId,
					runId: run._id,
					number: 0,
					sourceKey: 'tool:scheduled-command:finished',
					kind: 'tool',
					tool: {
						toolInvocationId: 'scheduled-command',
						name: 'poll_cmd',
						callId: 'scheduled',
						status: 'failed'
					},
					work: { ranges: [] }
				});
			});

			await t.run((ctx) =>
				ctx.db.insert('threadTranscriptStates', {
					threadId,
					userId: 'user_alice',
					totalParts: 0,
					workThrough: { part: 0, item: 0 }
				})
			);

			const previousScheduleId = await t.run((ctx) =>
				ctx.db.insert('migrationSchedules', {
					name: 'legacy-compat-backfill-2026-10',
					notBefore: 1,
					startedAt: 1,
					completedAt: 2
				})
			);

			await t.mutation(internal.migrations.runLegacyCompatBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runLegacyCompatBackfillAutomatically, {});

			const schedule = await t.run((ctx) =>
				ctx.db
					.query('migrationSchedules')
					.withIndex('by_name', (q) =>
						q.eq('name', 'legacy-compat-backfill-2026-10-command-inputs')
					)
					.unique()
			);

			expect(schedule?.completedAt).toBeDefined();
			expect(
				(await t.run((ctx) => ctx.db.get('migrationSchedules', previousScheduleId)))?.completedAt
			).toBe(2);
			expect(
				(await t.run((ctx) => ctx.db.get('threadTranscriptParts', commandPartId)))?.tool?.input
			).toEqual({ sessionId: 'scheduled' });

			const states = await t.run((ctx) =>
				ctx.db.query('threadTranscriptStates').withIndex('by_threadId').collect()
			);

			expect(states.every((state) => state.workThrough === undefined)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
