import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
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
	title: 'Notes',
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
		expect(metadata.page).toEqual([{ artifactId: created.artifactId, title: fields.title }]);

		const uiMetadata = await asUser.query(api.artifacts.listArtifactMetadata, {
			repositoryKey,
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(uiMetadata.page).toEqual([{ _id: created.artifactId, title: fields.title }]);
	});

	it('keeps the source path when edits omit it and clears it on null', async () => {
		const { asUser, repositoryKey, auth } = await seedActiveRun();

		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			sourcePath: 'docs/notes.md'
		});

		const load = () => asUser.query(api.artifacts.getArtifact, { artifactId, repositoryKey });

		expect(await load()).toMatchObject({ sourcePath: 'docs/notes.md', revision: 1 });

		await asUser.mutation(api.artifacts.syncArtifact, {
			artifactId,
			repositoryKey,
			expectedRevision: 1,
			content: 'synced'
		});
		const edit = { ...auth, artifactId, title: fields.title, content: 'edited' };
		await asUser.mutation(api.artifacts.editArtifact, { ...edit, expectedRevision: 2 });
		expect(await load()).toMatchObject({ sourcePath: 'docs/notes.md', revision: 3 });

		await asUser.mutation(api.artifacts.editArtifact, {
			...edit,
			expectedRevision: 3,
			sourcePath: 'hardware/notes.md'
		});
		expect(await load()).toMatchObject({ sourcePath: 'hardware/notes.md', revision: 4 });

		await asUser.mutation(api.artifacts.editArtifact, {
			...edit,
			expectedRevision: 4,
			sourcePath: null
		});
		const external = await load();
		expect(external.revision).toBe(5);
		expect(external).not.toHaveProperty('sourcePath');
	});

	it.each([
		'',
		'/tmp/notes.md',
		'C:/notes.md',
		'\\\\host\\notes.md',
		'../notes.md',
		'docs/../notes.md',
		'./notes.md',
		'docs//notes.md',
		'notes\0.md'
	])('rejects unsafe source path %j on add and edit', async (sourcePath) => {
		const { asUser, auth } = await seedActiveRun();
		await expect(
			asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields, sourcePath })
		).rejects.toThrow(/project-relative/i);

		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields
		});

		await expect(
			asUser.mutation(api.artifacts.editArtifact, {
				...auth,
				artifactId,
				expectedRevision: 1,
				title: fields.title,
				content: fields.content,
				sourcePath
			})
		).rejects.toThrow(/project-relative/i);
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
			title: 'Edited.html',
			content: '<p>edited</p>'
		};

		await expect(asUser.mutation(api.artifacts.editArtifact, edit)).rejects.toThrow(/changed/i);

		expect(
			await asUser.mutation(api.artifacts.editArtifact, { ...edit, expectedRevision: 2 })
		).toEqual({ artifactId: created.artifactId });
		const state = await asUser.query(api.artifacts.getArtifactState, { repositoryKey });
		expect(state).toBe(3);
		expect(
			await asUser.query(api.artifacts.getArtifactForRun, {
				...auth,
				artifactId: created.artifactId
			})
		).toMatchObject({ content: '<p>edited</p>', revision: 3 });
	});

	it("accepts released clients' content types and derives the type they read from the title", async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();

		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			title: 'app.JSX',
			contentType: 'markdown'
		});

		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).not.toHaveProperty('type');
		expect(
			await asUser.query(api.artifacts.getArtifactForRun, { ...auth, artifactId })
		).toMatchObject({ type: 'react' });
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([
			expect.objectContaining({ _id: artifactId, type: 'react' })
		]);
	});

	it('allows project-wide access across threads', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();

		const created = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields
		});

		const stored = await t.run((ctx) => ctx.db.get('artifacts', created.artifactId));
		expect(stored?.scope).toBe('project');
		expect(stored).not.toHaveProperty('threadId');

		const otherRun = await seedActiveRun('user_alice', t);
		expect(
			await otherRun.asUser.query(api.artifacts.getArtifactForRun, {
				...otherRun.auth,
				artifactId: created.artifactId
			})
		).toMatchObject({ _id: created.artifactId, scope: 'project' });

		const listed = await asUser.query(api.artifacts.listArtifacts, { repositoryKey });
		expect(listed.page.map((artifact) => artifact._id)).toEqual([created.artifactId]);

		const loaded = await asUser.query(api.artifacts.getArtifact, {
			repositoryKey,
			artifactId: created.artifactId
		});

		expect(loaded.scope).toBe('project');
		expect(loaded).not.toHaveProperty('threadId');
		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				repositoryKey,
				artifactId: created.artifactId,
				expectedRevision: 1,
				content: 'initial'
			})
		).toBe(true);

		expect(await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields })).toEqual(
			created
		);

		await expect(
			asUser.query(api.artifacts.getArtifact, {
				artifactId: created.artifactId,
				repositoryKey: 'other'
			})
		).rejects.toThrow(/not found/i);
		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(
			bob.query(api.artifacts.getArtifact, {
				repositoryKey,
				artifactId: created.artifactId
			})
		).rejects.toThrow(/not found/i);
		await expect(t.query(api.artifacts.listArtifacts, { repositoryKey })).rejects.toThrow(
			/authentication required/i
		);
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

	it('allows run ID operations across projects and lists the requested project or defaults to the run project', async () => {
		const { t, asUser, repositoryKey, auth } = await seedActiveRun();
		const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		const otherRun = await seedActiveRun('user_alice', t);
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', otherRun.threadId, { repositoryKey: 'other' })
		);

		expect(
			await asUser.query(api.artifacts.getArtifactForRun, { ...otherRun.auth, artifactId })
		).toMatchObject({ _id: artifactId, repositoryKey, content: fields.content });
		expect((await asUser.query(api.artifacts.listArtifactsForRun, otherRun.auth)).page).toEqual([]);
		expect(
			await asUser.query(api.artifacts.listArtifactsForRun, { ...otherRun.auth, repositoryKey })
		).toMatchObject({ page: [{ artifactId, title: fields.title }], revision: 1 });

		await asUser.mutation(api.artifacts.editArtifact, {
			...otherRun.auth,
			artifactId,
			expectedRevision: 1,
			title: fields.title,
			content: 'edited from another project'
		});
		expect(
			await asUser.query(api.artifacts.getArtifactForRun, { ...auth, artifactId })
		).toMatchObject({ content: 'edited from another project', revision: 2 });
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(2);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(0);

		expect(
			await asUser.mutation(api.artifacts.deleteArtifactForRun, { ...otherRun.auth, artifactId })
		).toEqual({ artifactId });
		expect(
			await asUser.query(api.artifacts.listArtifactsForRun, { ...otherRun.auth, repositoryKey })
		).toMatchObject({ page: [], revision: 3 });
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(0);
	});

	it.each(['run', 'user'] as const)(
		'transfers through %s auth without losing identity or accepting stale writes',
		async (authKind) => {
			const { asUser, repositoryKey, auth } = await seedActiveRun();

			const { artifactId } = await asUser.mutation(api.artifacts.addArtifact, {
				...auth,
				...fields,
				sourcePath: 'docs/notes.md'
			});

			const load = () => asUser.query(api.artifacts.getArtifactForRun, { ...auth, artifactId });

			const transfer = (destination: string) =>
				authKind === 'run'
					? asUser.mutation(api.artifacts.transferArtifactForRun, {
							...auth,
							artifactId,
							repositoryKey: destination
						})
					: asUser.mutation(api.artifacts.transferArtifact, {
							artifactId,
							repositoryKey: destination
						});

			const original = await load();

			await expect(transfer(' ')).rejects.toThrow(/repository key is required/i);
			expect(await transfer(repositoryKey)).toEqual({});
			expect(await load()).toEqual(original);
			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);

			expect(await transfer(' other ')).toEqual({});
			const moved = await load();
			expect(moved).toMatchObject({
				_id: original._id,
				_creationTime: original._creationTime,
				userId: original.userId,
				scope: original.scope,
				title: original.title,
				content: original.content,
				registrationId: original.registrationId,
				repositoryKey: 'other',
				revision: original.revision + 1
			});
			expect(moved).not.toHaveProperty('sourcePath');
			expect(await asUser.query(api.artifacts.listArtifactsForRun, auth)).toMatchObject({
				page: [],
				revision: 2
			});
			expect(
				await asUser.query(api.artifacts.listArtifactsForRun, { ...auth, repositoryKey: 'other' })
			).toMatchObject({ page: [{ artifactId, title: fields.title }], revision: 1 });
			expect(await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields })).toEqual({
				artifactId
			});
			expect(
				(await asUser.query(api.artifacts.listArtifacts, { repositoryKey: 'other' })).page
			).toHaveLength(1);
			expect(await transfer('other')).toEqual({});
			expect(await load()).toEqual(moved);
			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(
				1
			);

			const staleSync = { artifactId, repositoryKey, expectedRevision: 1, content: 'stale' };
			await expect(asUser.mutation(api.artifacts.syncArtifact, staleSync)).rejects.toThrow(
				/not found/i
			);
			expect(
				await asUser.mutation(api.artifacts.syncArtifact, { ...staleSync, repositoryKey: 'other' })
			).toBe(false);
			await expect(
				asUser.mutation(api.artifacts.editArtifact, {
					...auth,
					artifactId,
					expectedRevision: 1,
					title: fields.title,
					content: 'stale'
				})
			).rejects.toThrow(/changed/i);

			await transfer(repositoryKey);
			expect(await asUser.mutation(api.artifacts.syncArtifact, staleSync)).toBe(false);
			expect(await load()).toMatchObject({ content: fields.content, repositoryKey, revision: 3 });
			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(3);
			expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(
				2
			);
		}
	);

	it('persists artifact tool jobs, including transfers with empty results', async () => {
		const { t, asUser, auth } = await seedActiveRun();
		const artifact = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });

		for (const [index, kind] of (
			[
				'bind_artifact',
				'add_artifact',
				'edit_artifact',
				'save_artifact',
				'list_artifacts',
				'transfer_artifact'
			] as const
		).entries()) {
			const payload =
				kind === 'list_artifacts'
					? { repositoryKey: 'other' }
					: kind === 'transfer_artifact'
						? { artifactId: artifact.artifactId, repositoryKey: 'other' }
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
								(metadata) => ({ ...metadata, path: '/workspace/Notes' })
							)
						}
					: kind === 'transfer_artifact'
						? {}
						: { ...artifact, path: '/workspace/Notes', wiringIssues: [] };

			expect(
				await asUser.mutation(api.executor.complete, { ...auth, jobId: job.jobId, result })
			).toBe(true);
		}

		const jobs = await t.run(async (ctx) => ctx.db.query('executorJobs').collect());
		expect(jobs).toHaveLength(6);

		for (const job of jobs) {
			expect(job.status).toBe('completed');
			expect(job.payload).not.toHaveProperty('path');
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

	it('deletes idempotently, rejects stale sync, and allows explicit registration again', async () => {
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
				title: 'Notes'
			})
		).rejects.toThrow(/not found/i);

		const recreated = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		expect(recreated.artifactId).not.toBe(artifactId);
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([
			expect.objectContaining({ _id: recreated.artifactId, content: fields.content })
		]);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(3);
	});

	it('enforces account boundaries and legacy project boundaries before changing registry state', async () => {
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
			bobRun.asUser.query(api.artifacts.getArtifactForRun, { ...bobRun.auth, artifactId })
		).rejects.toThrow(/not found/i);
		await expect(
			bobRun.asUser.mutation(api.artifacts.editArtifact, {
				...bobRun.auth,
				artifactId,
				expectedRevision: 1,
				title: fields.title,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		await expect(
			bobRun.asUser.mutation(api.artifacts.deleteArtifactForRun, {
				...bobRun.auth,
				artifactId
			})
		).rejects.toThrow(/not found/i);
		await expect(
			bobRun.asUser.mutation(api.artifacts.transferArtifactForRun, {
				...bobRun.auth,
				artifactId,
				repositoryKey: 'other'
			})
		).rejects.toThrow(/not found/i);
		await expect(
			bob.mutation(api.artifacts.transferArtifact, { artifactId, repositoryKey: 'other' })
		).rejects.toThrow(/not found/i);
		await expect(
			t.mutation(api.artifacts.transferArtifact, { artifactId, repositoryKey: 'other' })
		).rejects.toThrow(/authentication required/i);
		expect(
			await bobRun.asUser.query(api.artifacts.listArtifactsForRun, {
				...bobRun.auth,
				repositoryKey
			})
		).toMatchObject({ page: [], revision: 0 });
		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).not.toBeNull();
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(1);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey: 'other' })).toBe(0);
	});

	it('requires an active claim and deletes through the agent mutation', async () => {
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
			await expect(
				asUser.mutation(api.artifacts.transferArtifactForRun, {
					...invalidAuth,
					artifactId,
					repositoryKey: 'other'
				})
			).rejects.toThrow();
		}

		expect(await t.run((ctx) => ctx.db.get('artifacts', artifactId))).not.toBeNull();

		const result = await asUser.mutation(api.artifacts.deleteArtifactForRun, {
			...auth,
			artifactId
		});

		expect(result).toEqual({ artifactId });
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([]);
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey })).toBe(2);
		await t.run((ctx) => ctx.db.patch('runs', auth.runId, { status: 'completed' }));
		await expect(
			asUser.mutation(api.artifacts.deleteArtifactForRun, { ...auth, artifactId })
		).rejects.toThrow(/no longer active/i);
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
					title: `Notes ${i}`,
					revision: 1,
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
