import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

async function seedActiveRun(
	executionSecret: string,
	existingT?: ReturnType<typeof initConvexTest>,
	subject = 'user_alice'
) {
	const t = existingT ?? initConvexTest();
	const { asUser, threadId, repositoryKey } = await seedOwnedThread(t, subject);
	const claimId = `claim-${Math.random()}`;
	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-artifact-${Math.random()}`,
		executionSecret,
		'Create an artifact'
	);
	await asUser.mutation(api.agentRuntime.start, {
		claimId,
		runId: created.runId,
		executionSecret
	});
	return {
		t,
		asUser,
		threadId,
		repositoryKey,
		runId: created.runId,
		claimId,
		executionSecret
	};
}

async function seedActiveRunForThread(
	t: ReturnType<typeof initConvexTest>,
	asUser: Awaited<ReturnType<typeof seedOwnedThread>>['asUser'],
	threadId: Awaited<ReturnType<typeof seedOwnedThread>>['threadId'],
	executionSecret: string
) {
	const claimId = `claim-${Math.random()}`;
	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-artifact-${Math.random()}`,
		executionSecret,
		'Create an artifact'
	);
	await asUser.mutation(api.agentRuntime.start, {
		claimId,
		runId: created.runId,
		executionSecret
	});
	return { runId: created.runId, claimId, executionSecret };
}

describe('artifacts', () => {
	it('pages content beyond one transaction and invalidates the lightweight registry on edits', async () => {
		const { t, asUser, threadId, repositoryKey, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-pages');
		for (let i = 0; i < 36; i += 1) {
			await t.run(async (ctx) => {
				await ctx.db.insert('artifacts', {
					userId: 'user_alice',
					scope: 'project',
					repositoryKey,
					localPath: `${i}.md`,
					content: 'x'.repeat(500_000),
					type: 'markdown',
					title: `${i}.md`,
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
			pages += 1;
			if (result.isDone) break;
			expect(result.continueCursor).not.toBe(cursor);
			cursor = result.continueCursor;
		}
		expect(count).toBe(36);
		expect(pages).toBeGreaterThan(4);
		const listed = await asUser.query(api.artifacts.listArtifactsForRun, {
			runId,
			claimId,
			executionSecret
		});
		expect(listed.page.every((artifact) => !('content' in artifact))).toBe(true);
		const state = await asUser.query(api.artifacts.getArtifactState, { repositoryKey, threadId });
		const first = (await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page[0]!;
		await asUser.mutation(api.artifacts.syncArtifact, {
			repositoryKey,
			artifactId: first._id,
			expectedRevision: first.revision,
			localPath: first.localPath,
			content: 'updated'
		});
		expect(await asUser.query(api.artifacts.getArtifactState, { repositoryKey, threadId })).toBe(
			state + 1
		);
		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, {
			from: repositoryKey,
			to: 'beta'
		});
		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, { from: 'beta', to: 'gamma' });
		for (let i = 0; i < 5; i += 1) {
			await t.mutation(internal.artifacts.continueRekey, {
				userId: 'user_alice',
				from: repositoryKey,
				to: 'beta'
			});
		}
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([]);
		expect(
			(await asUser.query(api.artifacts.listArtifacts, { repositoryKey: 'beta' })).page
		).toEqual([]);
		expect(
			await t.run(async (ctx) => (await ctx.db.get('artifacts', first._id))?.repositoryKey)
		).toBe('gamma');
	}, 15_000);

	it('adds a thread-scoped artifact and lists it with project artifacts', async () => {
		const { asUser, threadId, repositoryKey, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-add-secret');

		const created = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'notes.md',
			title: 'notes.md',
			contentType: 'markdown',
			content: '# hello'
		});
		expect(created).toMatchObject({
			revision: 1,
			title: 'notes.md',
			contentType: 'markdown',
			localPath: 'notes.md',
			scope: 'thread'
		});

		await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'project',
			localPath: 'preview.tsx',
			title: 'preview.tsx',
			contentType: 'react',
			content: 'export default function Preview() { return null; }'
		});

		const listed = await asUser.query(api.artifacts.listArtifactsForRun, {
			runId,
			claimId,
			executionSecret
		});
		expect(listed.page.map((artifact) => artifact.localPath).sort()).toEqual([
			'notes.md',
			'preview.tsx'
		]);

		const forThread = await asUser.query(api.artifacts.listArtifacts, {
			threadId,
			repositoryKey
		});
		expect(forThread.page).toHaveLength(2);

		const projectOnly = await asUser.query(api.artifacts.listArtifacts, { repositoryKey });
		expect(projectOnly.page).toHaveLength(1);
		expect(projectOnly.page[0]).toMatchObject({
			scope: 'project',
			localPath: 'preview.tsx'
		});
	});

	it('preserves identity on edit and bumps revision', async () => {
		const { asUser, runId, claimId, executionSecret } = await seedActiveRun('artifact-edit-secret');
		const created = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'notes.md',
			title: 'notes.md',
			contentType: 'markdown',
			content: '# v1'
		});

		const updated = await asUser.mutation(api.artifacts.editArtifact, {
			runId,
			claimId,
			executionSecret,
			artifactId: created.artifactId,
			localPath: 'notes.md',
			title: 'notes.md',
			contentType: 'markdown',
			content: '# v2'
		});
		expect(updated).toEqual({
			artifactId: created.artifactId,
			revision: 2,
			title: 'notes.md',
			contentType: 'markdown',
			localPath: 'notes.md',
			scope: 'thread'
		});
	});

	it('upserts the same scope path instead of creating a second identity', async () => {
		const { asUser, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-upsert-secret');
		const first = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'shared.md',
			title: 'shared.md',
			contentType: 'markdown',
			content: 'one'
		});
		const retry = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'shared.md',
			title: 'shared.md',
			contentType: 'markdown',
			content: 'one'
		});
		const updated = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'shared.md',
			title: 'shared.md',
			contentType: 'markdown',
			content: 'two'
		});

		expect(retry).toEqual(first);
		expect(updated).toEqual({ ...first, revision: 2 });
	});

	it('lets another thread in the same repository edit project artifacts only', async () => {
		const runA = await seedActiveRun('artifact-project-a-secret');
		const created = await runA.asUser.mutation(api.artifacts.addArtifact, {
			runId: runA.runId,
			claimId: runA.claimId,
			executionSecret: runA.executionSecret,
			scope: 'project',
			localPath: 'board.html',
			title: 'board.html',
			contentType: 'html',
			content: '<p>a</p>'
		});
		const threadOnly = await runA.asUser.mutation(api.artifacts.addArtifact, {
			runId: runA.runId,
			claimId: runA.claimId,
			executionSecret: runA.executionSecret,
			scope: 'thread',
			localPath: 'private.md',
			title: 'private.md',
			contentType: 'markdown',
			content: 'secret'
		});

		const threadB = await seedThreadRecord(runA.t, 'user_alice', runA.repositoryKey);
		const runB = await seedActiveRunForThread(
			runA.t,
			runA.asUser,
			threadB,
			'artifact-project-b-secret'
		);

		const edited = await runA.asUser.mutation(api.artifacts.editArtifact, {
			runId: runB.runId,
			claimId: runB.claimId,
			executionSecret: runB.executionSecret,
			artifactId: created.artifactId,
			localPath: 'board.html',
			title: 'board.html',
			contentType: 'html',
			content: '<p>b</p>'
		});
		expect(edited.artifactId).toBe(created.artifactId);
		expect(edited.revision).toBe(2);

		await expect(
			runA.asUser.mutation(api.artifacts.editArtifact, {
				runId: runB.runId,
				claimId: runB.claimId,
				executionSecret: runB.executionSecret,
				artifactId: threadOnly.artifactId,
				localPath: 'private.md',
				title: 'private.md',
				contentType: 'markdown',
				content: 'hijacked'
			})
		).rejects.toThrow(/not found/i);

		const listed = await runA.asUser.query(api.artifacts.listArtifactsForRun, {
			runId: runB.runId,
			claimId: runB.claimId,
			executionSecret: runB.executionSecret
		});
		expect(listed.page.map((artifact) => artifact.localPath).sort()).toEqual(['board.html']);
	});

	it('rejects create when the run claim is inactive', async () => {
		const { asUser, runId, executionSecret } = await seedActiveRun('artifact-inactive-secret');
		await expect(
			asUser.mutation(api.artifacts.addArtifact, {
				runId,
				claimId: 'wrong-claim',
				executionSecret,
				scope: 'thread',
				localPath: 'nope.md',
				title: 'nope.md',
				contentType: 'markdown',
				content: 'x'
			})
		).rejects.toThrow(/no longer active/i);
	});

	it('rejects listing a thread that does not belong to the repository', async () => {
		const { asUser, threadId } = await seedActiveRun('artifact-repo-mismatch-secret');
		await expect(
			asUser.query(api.artifacts.listArtifacts, {
				threadId,
				repositoryKey: 'beta'
			})
		).rejects.toThrow(/not found/i);
	});

	it('does not leak another user artifacts that share a repository key', async () => {
		const alice = await seedActiveRun('artifact-alice-secret', undefined, 'user_alice');
		await alice.asUser.mutation(api.artifacts.addArtifact, {
			runId: alice.runId,
			claimId: alice.claimId,
			executionSecret: alice.executionSecret,
			scope: 'project',
			localPath: 'alice.md',
			title: 'alice.md',
			contentType: 'markdown',
			content: 'alice'
		});
		const bob = await seedActiveRun('artifact-bob-secret', alice.t, 'user_bob');
		await bob.asUser.mutation(api.artifacts.addArtifact, {
			runId: bob.runId,
			claimId: bob.claimId,
			executionSecret: bob.executionSecret,
			scope: 'project',
			localPath: 'bob.md',
			title: 'bob.md',
			contentType: 'markdown',
			content: 'bob'
		});

		const listed = await bob.asUser.query(api.artifacts.listArtifacts, {
			repositoryKey: 'alpha'
		});
		expect(listed.page).toHaveLength(1);
		expect(listed.page[0]?.localPath).toBe('bob.md');

		await expect(
			bob.asUser.query(api.artifacts.listArtifacts, {
				threadId: alice.threadId,
				repositoryKey: 'alpha'
			})
		).rejects.toThrow(/not found/i);
	});

	it('syncs when path and revision match and refuses stale writes', async () => {
		const { asUser, threadId, repositoryKey, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-sync-secret');
		const created = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'notes.md',
			title: 'notes.md',
			contentType: 'markdown',
			content: 'cloud'
		});

		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: created.artifactId,
				repositoryKey,
				threadId,
				expectedRevision: 1,
				localPath: 'notes.md',
				content: 'local'
			})
		).toBe(true);

		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: created.artifactId,
				repositoryKey,
				threadId,
				expectedRevision: 1,
				localPath: 'notes.md',
				content: 'stale-revision'
			})
		).toBe(false);

		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: created.artifactId,
				repositoryKey,
				threadId,
				expectedRevision: 2,
				localPath: 'other.md',
				content: 'stale-path'
			})
		).toBe(false);

		const listed = await asUser.query(api.artifacts.listArtifacts, { threadId, repositoryKey });
		expect(listed.page[0]).toMatchObject({
			content: 'local',
			revision: 2,
			localPath: 'notes.md'
		});
	});

	it('preserves relative and absolute paths and rejects invalid or oversized data', async () => {
		const { asUser, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-bounds-secret');
		const base = {
			runId,
			claimId,
			executionSecret,
			scope: 'thread' as const,
			title: 'notes.md',
			contentType: 'markdown' as const,
			content: 'x'
		};
		for (const localPath of [
			'../outside.md',
			'/tmp/notes.md',
			'C:\\docs\\notes.md',
			' spaced.md '
		]) {
			const result = await asUser.mutation(api.artifacts.addArtifact, { ...base, localPath });
			expect(result.localPath).toBe(localPath);
		}
		for (const localPath of ['', 'bad\0path', 'x'.repeat(4097)]) {
			await expect(
				asUser.mutation(api.artifacts.addArtifact, { ...base, localPath })
			).rejects.toThrow(/path/i);
		}
		await expect(
			asUser.mutation(api.artifacts.addArtifact, {
				...base,
				localPath: 'notes.md',
				content: 'é'.repeat(250_001)
			})
		).rejects.toThrow(/bytes/i);
	});

	it('records the file tools using their model-facing payloads and metadata-only results', async () => {
		const { t, asUser, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-job-secret');
		const auth = { runId, claimId, executionSecret };
		const addJob = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			kind: 'add_artifact',
			payload: { path: 'notes.md', scope: 'thread' }
		});
		const artifact = await asUser.mutation(api.artifacts.addArtifact, {
			...auth,
			scope: 'thread',
			localPath: 'notes.md',
			content: 'hello',
			title: 'notes.md',
			contentType: 'markdown'
		});
		expect(
			await asUser.mutation(api.executor.complete, {
				...auth,
				jobId: addJob.jobId,
				result: artifact
			})
		).toBe(true);
		const editJob = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			kind: 'edit_artifact',
			payload: { artifactId: artifact.artifactId, path: 'moved.md' }
		});
		const edited = await asUser.mutation(api.artifacts.editArtifact, {
			...auth,
			artifactId: artifact.artifactId,
			localPath: 'moved.md',
			content: 'new',
			title: 'moved.md',
			contentType: 'markdown'
		});
		expect(
			await asUser.mutation(api.executor.complete, {
				...auth,
				jobId: editJob.jobId,
				result: edited
			})
		).toBe(true);
		const listJob = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			kind: 'list_artifacts',
			payload: {}
		});
		const docs = await asUser.query(api.artifacts.listArtifactsForRun, auth);
		const artifacts = docs.page;
		expect(
			await asUser.mutation(api.executor.complete, {
				...auth,
				jobId: listJob.jobId,
				result: { artifacts }
			})
		).toBe(true);
		const jobs = await t.run(async (ctx) => ctx.db.query('executorJobs').collect());
		expect(jobs.map((job) => job.status)).toEqual(['completed', 'completed', 'completed']);
		expect(jobs.every((job) => !('content' in job.payload))).toBe(true);
	});

	it('rekeys artifacts with their repository', async () => {
		const { asUser, repositoryKey, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-rekey-secret');
		await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'project',
			localPath: 'preview.tsx',
			title: 'preview.tsx',
			contentType: 'react',
			content: 'export default function Preview() { return null; }'
		});
		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, {
			from: repositoryKey,
			to: 'omega'
		});
		expect((await asUser.query(api.artifacts.listArtifacts, { repositoryKey })).page).toEqual([]);
		const moved = await asUser.query(api.artifacts.listArtifacts, { repositoryKey: 'omega' });
		expect(moved.page).toHaveLength(1);
		expect(moved.page[0]?.localPath).toBe('preview.tsx');
	});

	it('allows project sync without a thread and refuses thread sync without one', async () => {
		const { asUser, repositoryKey, runId, claimId, executionSecret } = await seedActiveRun(
			'artifact-sync-scope-secret'
		);
		const project = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'project',
			localPath: 'preview.tsx',
			title: 'preview.tsx',
			contentType: 'react',
			content: 'one'
		});
		const threadScoped = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'thread',
			localPath: 'notes.md',
			title: 'notes.md',
			contentType: 'markdown',
			content: 'thread'
		});

		expect(
			await asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: project.artifactId,
				repositoryKey,
				expectedRevision: 1,
				localPath: 'preview.tsx',
				content: 'two'
			})
		).toBe(true);

		await expect(
			asUser.mutation(api.artifacts.syncArtifact, {
				artifactId: threadScoped.artifactId,
				repositoryKey,
				expectedRevision: 1,
				localPath: 'notes.md',
				content: 'nope'
			})
		).rejects.toThrow(/not found/i);
	});

	it('rejects unauthenticated list and cross-user sync', async () => {
		const { t, asUser, repositoryKey, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-authz-secret');
		const created = await asUser.mutation(api.artifacts.addArtifact, {
			runId,
			claimId,
			executionSecret,
			scope: 'project',
			localPath: 'preview.tsx',
			title: 'preview.tsx',
			contentType: 'react',
			content: 'one'
		});

		await expect(t.query(api.artifacts.listArtifacts, { repositoryKey })).rejects.toThrow(
			/authentication required/i
		);

		const bob = t.withIdentity({ subject: 'user_bob' });
		await expect(
			bob.mutation(api.artifacts.syncArtifact, {
				artifactId: created.artifactId,
				repositoryKey,
				expectedRevision: 1,
				localPath: 'preview.tsx',
				content: 'stolen'
			})
		).rejects.toThrow(/not found/i);
	});
});
