import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

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

	it('enforces thread, project and account boundaries for reads and writes', async () => {
		const { t, asUser, threadId, repositoryKey, auth } = await seedActiveRun();
		const project = await asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields });
		const privateArtifact = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			...fields,
			registrationId: 'private',
			scope: 'thread'
		});
		const otherThread = await seedThreadRecord(t, 'user_alice', repositoryKey);
		const anotherRepo = await seedThreadRecord(t, 'user_alice', 'other');
		const list = await asUser.query(api.artifacts.listArtifacts, { repositoryKey, threadId });
		expect(list.page).toHaveLength(2);
		expect(
			(await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page.map(
				(artifact) => artifact._id
			)
		).toEqual([project.artifactId]);
		for (const scope of [
			{ repositoryKey },
			{ repositoryKey, threadId: otherThread },
			{ repositoryKey: 'other', threadId: anotherRepo }
		]) {
			await expect(
				asUser.query(api.artifacts.getArtifact, {
					...scope,
					artifactId: privateArtifact.artifactId
				})
			).rejects.toThrow(/not found/i);
			await expect(
				asUser.mutation(api.artifacts.syncArtifact, {
					...scope,
					artifactId: privateArtifact.artifactId,
					expectedRevision: 1,
					content: 'forbidden'
				})
			).rejects.toThrow(/not found/i);
		}
		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(
			bob.query(api.artifacts.getArtifact, { repositoryKey, artifactId: project.artifactId })
		).rejects.toThrow(/not found/i);
		await expect(
			bob.mutation(api.artifacts.syncArtifact, {
				repositoryKey,
				artifactId: project.artifactId,
				expectedRevision: 1,
				content: 'forbidden'
			})
		).rejects.toThrow(/not found/i);
		await expect(t.query(api.artifacts.listArtifacts, { repositoryKey })).rejects.toThrow(
			/authentication required/i
		);
		await expect(
			asUser.mutation(api.artifacts.addArtifact, { ...auth, ...fields, scope: 'thread' })
		).rejects.toThrow(/not found/i);
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
		for (const kind of [
			'add_artifact',
			'edit_artifact',
			'save_artifact',
			'list_artifacts'
		] as const) {
			const payload =
				kind === 'add_artifact'
					? { scope: 'project' as const }
					: kind === 'list_artifacts'
						? {}
						: { artifactId: artifact.artifactId };
			const job = await asUser.mutation(api.agentRuntime.beginToolJob, { ...auth, kind, payload });
			const result =
				kind === 'list_artifacts'
					? { artifacts: (await asUser.query(api.artifacts.listArtifactsForRun, auth)).page }
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

	it('pages more than 16 MB of content and follows chained repository rekeys', async () => {
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
		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, {
			from: repositoryKey,
			to: 'beta'
		});
		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, { from: 'beta', to: 'gamma' });
		for (let i = 0; i < 5; i++)
			await t.mutation(internal.artifacts.continueRekey, {
				userId: 'user_alice',
				from: repositoryKey,
				to: 'beta'
			});
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([]);
		expect(
			(await asUser.query(api.artifacts.listArtifacts, { repositoryKey: 'beta' })).page
		).toEqual([]);
		expect(
			(await asUser.query(api.artifacts.listArtifacts, { repositoryKey: 'gamma' })).page.length
		).toBeGreaterThan(0);
	}, 15_000);
});
