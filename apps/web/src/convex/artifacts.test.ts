import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

async function seedActiveRun(
	executionSecret: string,
	existingT?: ReturnType<typeof initConvexTest>
) {
	const t = existingT ?? initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const claimId = `claim-${Math.random()}`;
	const created = await asUser.mutation(api.agentRuntime.createRun, {
		submissionId: `sub-artifact-${Math.random()}`,
		threadId,
		prompt: 'Create an artifact',
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
		executionSecret
	});
	await asUser.mutation(api.agentRuntime.start, {
		claimId,
		runId: created.runId,
		executionSecret
	});
	return { t, asUser, threadId, runId: created.runId, claimId, executionSecret };
}

describe('artifacts', () => {
	it('creates a versioned artifact for the active run', async () => {
		const { asUser, threadId, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-create-secret');

		const created = await asUser.mutation(api.artifacts.createArtifact, {
			runId,
			claimId,
			title: 'Landing mock',
			contentType: 'react',
			content: 'function App() { return null; }',
			executionSecret
		});

		expect(created).toMatchObject({ version: 1 });

		const listed = await asUser.query(api.artifacts.listArtifactsForThread, { threadId });
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			currentContent: 'function App() { return null; }',
			artifact: {
				title: 'Landing mock',
				type: 'react',
				currentVersion: 1
			}
		});

		const detail = await asUser.query(api.artifacts.getArtifact, {
			artifactId: created.artifactId
		});
		expect(detail.versions).toHaveLength(1);
		expect(detail.versions[0]).toMatchObject({
			version: 1,
			content: 'function App() { return null; }'
		});
	});

	it('appends a new version', async () => {
		const { asUser, runId, claimId, executionSecret } =
			await seedActiveRun('artifact-update-secret');

		const created = await asUser.mutation(api.artifacts.createArtifact, {
			runId,
			claimId,
			title: 'notes.md',
			contentType: 'markdown',
			content: '# v1',
			executionSecret
		});

		const updated = await asUser.mutation(api.artifacts.appendArtifactVersion, {
			artifactId: created.artifactId,
			runId,
			claimId,
			content: '# v2',
			executionSecret
		});

		expect(updated).toEqual({
			artifactId: created.artifactId,
			version: 2,
			title: 'notes.md',
			contentType: 'markdown'
		});

		const detail = await asUser.query(api.artifacts.getArtifact, {
			artifactId: created.artifactId
		});
		expect(detail.artifact.currentVersion).toBe(2);
		expect(detail.versions).toHaveLength(2);
		expect(detail.versions[1]).toMatchObject({
			version: 2,
			content: '# v2'
		});
	});

	it('upserts instead of dropping content for a repeated title', async () => {
		const { asUser, runId, claimId, executionSecret } = await seedActiveRun(
			'artifact-idempotent-secret'
		);

		const first = await asUser.mutation(api.artifacts.createArtifact, {
			runId,
			claimId,
			title: 'shared',
			contentType: 'markdown',
			content: 'one',
			executionSecret
		});
		const retry = await asUser.mutation(api.artifacts.createArtifact, {
			runId,
			claimId,
			title: 'shared',
			contentType: 'markdown',
			content: 'one',
			executionSecret
		});
		const updated = await asUser.mutation(api.artifacts.createArtifact, {
			runId,
			claimId,
			title: 'shared',
			contentType: 'markdown',
			content: 'two',
			executionSecret
		});

		// An identical retry is a no-op; new content becomes a new version.
		expect(retry).toEqual(first);
		expect(updated).toEqual({ ...first, version: 2 });

		const detail = await asUser.query(api.artifacts.getArtifact, {
			artifactId: first.artifactId
		});
		expect(detail.versions).toHaveLength(2);
		expect(detail.versions[1]).toMatchObject({ version: 2, content: 'two' });
	});

	it('rejects create when the run claim is inactive', async () => {
		const { asUser, runId, executionSecret } = await seedActiveRun('artifact-inactive-secret');

		await expect(
			asUser.mutation(api.artifacts.createArtifact, {
				runId,
				claimId: 'wrong-claim',
				title: 'nope',
				contentType: 'markdown',
				content: 'x',
				executionSecret
			})
		).rejects.toThrow(/no longer active/i);
	});

	it('rejects appending to an artifact from another thread', async () => {
		const t = initConvexTest();
		const runA = await seedActiveRun('artifact-thread-a-secret', t);
		const created = await runA.asUser.mutation(api.artifacts.createArtifact, {
			runId: runA.runId,
			claimId: runA.claimId,
			title: 'thread-a-artifact',
			contentType: 'markdown',
			content: 'one',
			executionSecret: runA.executionSecret
		});

		const runB = await seedActiveRun('artifact-thread-b-secret', t);
		await expect(
			runB.asUser.mutation(api.artifacts.appendArtifactVersion, {
				artifactId: created.artifactId,
				runId: runB.runId,
				claimId: runB.claimId,
				content: 'hijacked',
				executionSecret: runB.executionSecret
			})
		).rejects.toThrow(/not found/i);
	});
});
