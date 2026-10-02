import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	seedThreadRecord,
	toolTranscriptAssignment
} from './test.setup';

async function seedActiveRun(subject = 'user_alice', t = initConvexTest()) {
	const { asUser, threadId, repositoryKey } = await seedOwnedThread(t, subject);
	const executionSecret = crypto.randomUUID();
	const claimId = crypto.randomUUID();

	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		crypto.randomUUID(),
		executionSecret,
		'Create an artifact'
	);

	const auth = { runId, claimId, executionSecret };
	await asUser.mutation(api.agentRuntime.start, auth);

	return { t, asUser, threadId, repositoryKey, auth };
}

const fields = {
	registrationId: 'registration',
	scope: 'project' as const,
	title: 'Notes',
	contentType: 'markdown' as const,
	content: 'initial'
};

describe('cloud artifacts', () => {
	it('stores no local path, deduplicates retry identities, and returns cloud content without a workspace', async () => {
		const { asUser, repositoryKey, auth } = await seedActiveRun();
		const created = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });

		const retry = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			content: 'retry must not overwrite'
		});

		expect(retry).toEqual(created);

		const artifact = await asUser.query(api.artifacts.getArtifact, {
			artifactId: created.artifactId,
			repositoryKey
		});

		expect(artifact.content).toBe('initial');
		expect(artifact).not.toHaveProperty('localPath');
		expect(created).not.toHaveProperty('localPath');
		const metadata = await asUser.query(api.artifacts.listArtifactsForRun, auth);
		expect(metadata.page).toHaveLength(1);
		expect(metadata.page[0]).not.toHaveProperty('content');
		expect(metadata.page[0]).not.toHaveProperty('registrationId');
		expect(metadata.page[0]).not.toHaveProperty('localPath');
	});

	it('uses revision CAS for explicit edits and automatic sync', async () => {
		const { asUser, repositoryKey, auth } = await seedActiveRun();
		const created = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });

		const sync = {
			artifactId: created.artifactId,
			repositoryKey,
			expectedRevision: 1,
			content: 'synced'
		};

		expect(await asUser.mutation(api.artifacts.syncArtifact, sync)).toBe(true);
		expect(await asUser.mutation(api.artifacts.syncArtifact, { ...sync, content: 'stale' })).toBe(
			false
		);

		const edit = {
			...auth,
			artifactId: created.artifactId,
			expectedRevision: 1,
			title: 'Edited',
			contentType: 'html' as const,
			content: '<p>edited</p>'
		};

		await expect(asUser.mutation(api.artifacts.editArtifact, edit)).rejects.toThrow(/changed/i);

		const updated = await asUser.mutation(api.artifacts.editArtifact, {
			...edit,
			expectedRevision: 2
		});

		expect(updated.revision).toBe(3);
		const state = await asUser.query(api.artifacts.getArtifactState, { repositoryKey });
		expect(state).toBe(3);
		expect(
			(
				await asUser.query(api.artifacts.getArtifactForRun, {
					...auth,
					artifactId: created.artifactId
				})
			).content
		).toBe('<p>edited</p>');
	});

	it('promotes released thread-scope writes and allows project-wide access across threads', async () => {
		const { t, asUser, threadId, repositoryKey, auth } = await seedActiveRun();

		const created = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			scope: 'thread'
		});

		expect(created.scope).toBe('project');
		const stored = await t.run((ctx) => ctx.db.get('artifacts', created.artifactId));
		expect(stored?.scope).toBe('project');
		expect(stored).not.toHaveProperty('threadId');

		const otherThread = await seedThreadRecord(t, 'user_alice', repositoryKey);

		for (const project of [{ repositoryKey }, { repositoryKey, threadId: otherThread }]) {
			const listed = await asUser.query(api.artifacts.listArtifacts, project);
			expect(listed.page.map((artifact) => artifact._id)).toEqual([created.artifactId]);

			const loaded = await asUser.query(api.artifacts.getArtifact, {
				...project,
				artifactId: created.artifactId
			});

			expect(loaded.scope).toBe('project');
			expect(loaded).not.toHaveProperty('threadId');
			expect(
				await asUser.mutation(api.artifacts.syncArtifact, {
					...project,
					artifactId: created.artifactId,
					expectedRevision: 1,
					content: 'initial'
				})
			).toBe(true);
		}

		const { scope, ...currentFields } = fields;
		void scope;
		expect(await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...currentFields })).toEqual(
			created
		);
		expect(await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields })).toEqual(
			created
		);

		await expect(
			asUser.query(api.artifacts.getArtifact, {
				artifactId: created.artifactId,
				repositoryKey: 'other'
			})
		).rejects.toThrow(/not found/i);
		await expect(
			asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: created.artifactId,
				repositoryKey: 'other',
				expectedRevision: 1,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		await expect(
			asUser.query(api.artifacts.listArtifacts, {
				repositoryKey: 'other',
				threadId
			})
		).rejects.toThrow(/not found/i);

		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(
			bob.query(api.artifacts.getArtifact, {
				repositoryKey,
				artifactId: created.artifactId
			})
		).rejects.toThrow(/not found/i);
		await expect(
			bob.mutation(api.artifacts.syncArtifact, {
				repositoryKey,
				artifactId: created.artifactId,
				expectedRevision: 1,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		await expect(t.query(api.artifacts.listArtifacts, { repositoryKey })).rejects.toThrow(
			/authentication required/i
		);
	});

	it('reads historical thread artifacts as project artifacts and promotes unchanged writes in place', async () => {
		const { t, asUser, threadId, repositoryKey, auth } = await seedActiveRun();

		const legacyId = await t.run((ctx) =>
			ctx.db.insert('artifacts', {
				userId: 'user_alice',
				scope: 'thread',
				threadId,
				repositoryKey,
				registrationId: fields.registrationId,
				content: fields.content,
				type: fields.contentType,
				title: fields.title,
				revision: 7,
				createdAt: 1,
				updatedAt: 2
			})
		);

		const otherRun = await seedActiveRun('user_alice', t);
		expect(otherRun.repositoryKey).toBe(repositoryKey);

		const loaded = await otherRun.asUser.query(api.artifacts.getArtifactForRun, {
			...otherRun.auth,
			artifactId: legacyId
		});

		expect(loaded).toMatchObject({ _id: legacyId, scope: 'project', revision: 7 });
		expect(loaded).not.toHaveProperty('threadId');
		const listed = await asUser.query(api.artifacts.listArtifactsForRun, auth);
		expect(listed.page[0]).toMatchObject({ artifactId: legacyId, scope: 'project' });
		expect(listed.page[0]).not.toHaveProperty('threadId');
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toHaveLength(
			1
		);

		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: legacyId,
				repositoryKey,
				expectedRevision: 7,
				content: fields.content
			})
		).toBe(true);
		expect(await t.run((ctx) => ctx.db.get('artifacts', legacyId))).toMatchObject({
			scope: 'project',
			revision: 7,
			createdAt: 1,
			updatedAt: 2
		});
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);

		const retry = await asUser.mutation(api.artifacts.addArtifact, {
			...otherRun.auth,
			...fields,
			scope: 'thread'
		});

		expect(retry).toMatchObject({ artifactId: legacyId, scope: 'project', revision: 7 });
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);
	});

	it('automatically migrates legacy artifacts even after earlier backfills completed', async () => {
		vi.useFakeTimers();

		try {
			const { t, asUser, threadId, repositoryKey } = await seedActiveRun();

			const artifactIds = await t.run(async (ctx) => {
				await ctx.db.insert('migrationSchedules', {
					name: 'legacy-compat-backfill-2026-10',
					notBefore: 1,
					startedAt: 1,
					completedAt: 2
				});

				const ids = [];

				for (let index = 0; index < 19; index++) {
					ids.push(
						await ctx.db.insert('artifacts', {
							userId: 'user_alice',
							scope: 'thread',
							threadId,
							repositoryKey,
							registrationId: `legacy-${index}`,
							content: 'preserved',
							type: 'markdown',
							title: 'Legacy',
							revision: 4,
							createdAt: 1,
							updatedAt: 2
						})
					);
				}

				return ids;
			});

			await t.mutation(internal.migrations.runProjectArtifactBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runProjectArtifactBackfillAutomatically, {});

			for (const artifactId of artifactIds) {
				const stored = await t.run((ctx) => ctx.db.get('artifacts', artifactId));
				expect(stored).toMatchObject({
					scope: 'project',
					content: 'preserved',
					revision: 4,
					createdAt: 1,
					updatedAt: 2
				});
				expect(stored).not.toHaveProperty('threadId');
			}

			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(19);

			const schedule = await t.run((ctx) =>
				ctx.db
					.query('migrationSchedules')
					.withIndex('by_name', (q) => q.eq('name', 'project-artifacts-2026-10'))
					.unique()
			);

			expect(schedule?.completedAt).toBeDefined();
			await t.mutation(internal.migrations.runProjectArtifactBackfillAutomatically, {});
			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(19);
		} finally {
			vi.useRealTimers();
		}
	});

	it('requires an active execution claim and validates content bytes and opaque registration IDs', async () => {
		const { asUser, auth } = await seedActiveRun();

		for (const registrationId of ['', 'x'.repeat(129)]) {
			await expect(
				asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields, registrationId })
			).rejects.toThrow(/registration/i);
		}

		await expect(
			asUser.mutation(api.artifacts.addArtifact, {
				...auth,
				...fields,
				content: 'é'.repeat(250_001)
			})
		).rejects.toThrow(/500000/);
		await expect(
			asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields, title: ' ' })
		).rejects.toThrow(/empty/i);
		await expect(
			asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields, claimId: 'expired' })
		).rejects.toThrow();
		const created = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		await expect(
			asUser.query(api.artifacts.getArtifactForRun, {
				...auth,
				artifactId: created.artifactId,
				claimId: 'expired'
			})
		).rejects.toThrow();
	});

	it('persists path-free add, edit, save and list tool jobs', async () => {
		const { t, asUser, auth } = await seedActiveRun();
		const artifact = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });

		for (const [index, kind] of (
			['add_artifact', 'edit_artifact', 'save_artifact', 'list_artifacts'] as const
		).entries()) {
			const payload =
				kind === 'add_artifact' || kind === 'list_artifacts'
					? {}
					: { artifactId: artifact.artifactId };

			const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
				...auth,
				...toolTranscriptAssignment(auth.runId, auth.claimId, index + 1),
				kind,
				payload
			});

			const result =
				kind === 'list_artifacts'
					? {
							artifacts: (await asUser.query(api.artifacts.listArtifactsForRun, auth)).page.map(
								({ scope, ...metadata }) => {
									void scope;

									return metadata;
								}
							)
						}
					: artifact;

			expect(
				await asUser.mutation(api.executor.complete, { ...auth, jobId: job.jobId, result })
			).toBe(true);
		}

		const jobs = await t.run(async (ctx) => ctx.db.query('executorJobs').collect());
		expect(jobs).toHaveLength(4);

		for (const job of jobs) {
			expect(job.status).toBe('completed');
			expect(job.payload).not.toHaveProperty('path');
			expect(job.result).not.toHaveProperty('localPath');
		}
	});

	it('keeps released thread-scope executor payloads and results readable', async () => {
		const { t, asUser, threadId, auth } = await seedActiveRun();
		const artifact = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		const metadata = (await asUser.query(api.artifacts.listArtifactsForRun, auth)).page[0];

		const results = [
			{
				kind: 'add_artifact' as const,
				payload: { scope: 'thread' as const },
				result: { ...artifact, scope: 'thread' as const }
			},
			{
				kind: 'list_artifacts' as const,
				payload: {},
				result: { artifacts: [{ ...metadata, scope: 'thread' as const, threadId }] }
			}
		];

		for (const [index, { kind, payload, result }] of results.entries()) {
			const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
				...auth,
				...toolTranscriptAssignment(auth.runId, auth.claimId, index + 1),
				kind,
				payload
			});

			expect(
				await asUser.mutation(api.executor.complete, { ...auth, jobId: job.jobId, result })
			).toBe(true);
		}

		const jobs = await t.run((ctx) => ctx.db.query('executorJobs').collect());
		expect(jobs.map((job) => job.result)).toEqual(results.map(({ result }) => result));
	});

	it('deletes project artifacts once and rejects stale sync without recreating them', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();
		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		const args = { artifactId, repositoryKey };
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);
		expect(await asUser.mutation(api.artifacts.deleteArtifact, args)).toEqual({ artifactId });
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(2);
		expect(await asUser.mutation(api.artifacts.deleteArtifact, args)).toEqual({ artifactId });
		expect(
			await asUser.mutation(api.artifacts.deleteArtifactForRun, { ...auth, artifactId })
		).toEqual({ artifactId });
		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				...args,
				expectedRevision: 1,
				content: 'stale local update'
			})
		).toBe(false);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(2);
		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).toBeNull();
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([]);
		await expect(asUser.query(api.artifacts.getArtifact, args)).rejects.toThrow(/not found/i);
		await expect(
			asUser.mutation(api.artifacts.editArtifact, {
				...auth,
				artifactId,
				expectedRevision: 1,
				content: 'stale edit',
				title: 'Notes',
				contentType: 'markdown'
			})
		).rejects.toThrow(/not found/i);
	});

	it('enforces deletion account and project boundaries before changing registry state', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();
		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		await expect(
			t.mutation(api.artifacts.deleteArtifact, { artifactId, repositoryKey })
		).rejects.toThrow(/authentication required/i);
		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(
			bob.mutation(api.artifacts.deleteArtifact, { artifactId, repositoryKey })
		).rejects.toThrow(/not found/i);
		await expect(
			asUser.mutation(api.artifacts.deleteArtifact, { artifactId, repositoryKey: 'other' })
		).rejects.toThrow(/not found/i);
		await expect(
			bob.mutation(api.artifacts.syncArtifact, {
				artifactId,
				repositoryKey,
				expectedRevision: 1,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		await expect(
			asUser.mutation(api.artifacts.syncArtifact, {
				artifactId,
				repositoryKey: 'other',
				expectedRevision: 1,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		const bobRun = await seedActiveRun('user_bob', t);
		await expect(
			bobRun.asUser.mutation(api.artifacts.deleteArtifactForRun, {
				...bobRun.auth,
				artifactId
			})
		).rejects.toThrow(/not found/i);
		const otherProjectRun = await seedActiveRun('user_alice', t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', otherProjectRun.threadId, { repositoryKey: 'other' })
		);
		await expect(
			asUser.mutation(api.artifacts.deleteArtifactForRun, {
				...otherProjectRun.auth,
				artifactId
			})
		).rejects.toThrow(/not found/i);
		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).not.toBeNull();
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(0);
	});

	it('requires an active claim for deletion and persists agent deletion tool history', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();
		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });

		for (const invalidAuth of [
			{ ...auth, claimId: 'expired' },
			{ ...auth, executionSecret: 'wrong-secret' }
		]) {
			await expect(
				asUser.mutation(api.artifacts.deleteArtifactForRun, {
					...invalidAuth,
					artifactId
				})
			).rejects.toThrow();
		}

		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).not.toBeNull();

		const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			...toolTranscriptAssignment(auth.runId, auth.claimId, 1),
			kind: 'delete_artifact',
			payload: { artifactId }
		});

		const result = await asUser.mutation(api.artifacts.deleteArtifactForRun, {
			...auth,
			artifactId
		});

		expect(result).toEqual({ artifactId });
		expect(
			await asUser.mutation(api.executor.complete, { ...auth, jobId: job.jobId, result })
		).toBe(true);
		const storedJob = await t.run((ctx) => ctx.db.get('executorJobs', job.jobId));
		expect(storedJob).toMatchObject({
			kind: 'delete_artifact',
			status: 'completed',
			payload: { artifactId },
			result: { artifactId }
		});
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(2);
		await t.run((ctx) => ctx.db.patch('runs', auth.runId, { status: 'completed' }));
		await expect(
			asUser.mutation(api.artifacts.deleteArtifactForRun, { ...auth, artifactId })
		).rejects.toThrow(/no longer active/i);
	});

	it('rejects reuse of a deleted registration and allows a fresh registration', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();
		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		await asUser.mutation(api.artifacts.deleteArtifact, { repositoryKey, artifactId });
		await expect(
			asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields })
		).rejects.toThrow(/registration was deleted/i);
		expect(await t.run((ctx) => ctx.db.query('artifacts').collect())).toEqual([]);

		const recreated = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			registrationId: 'new-registration'
		});
		expect(recreated.artifactId).not.toBe(artifactId);
	});

	it('pages more than 16 MB of content', async () => {
		const { t, asUser, repositoryKey } = await seedActiveRun();

		for (let i = 0; i < 36; i++) {
			await t.run(async (ctx) => {
				await ctx.db.insert('artifacts', {
					userId: 'user_alice',
					scope: 'project',
					repositoryKey,
					registrationId: `registration-${i}`,
					content: 'x'.repeat(500_000),
					type: 'markdown',
					title: `Notes ${i}`,
					revision: 1,
					createdAt: 1,
					updatedAt: 1
				});
			});
		}

		let cursor: string | null = null;
		let count = 0;
		let pages = 0;

		for (;;) {
			const result: { page: Doc<'artifacts'>[]; isDone: boolean; continueCursor: string } =
				await asUser.query(api.artifacts.listArtifacts, { repositoryKey, cursor });

			count += result.page.length;
			pages++;

			if (result.isDone) break;
			expect(result.continueCursor).not.toBe(cursor);
			cursor = result.continueCursor;
		}

		expect(count).toBe(36);
		expect(pages).toBeGreaterThan(4);
	}, 15_000);
});
