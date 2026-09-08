import { describe, expect, it } from 'vitest';
import { defineSchema } from 'convex/server';
import { convexTest } from 'convex-test';
import contextDevTest from '@context-dot-dev/convex/test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import exaTest from '@exalabs/convex-exa/test';
import migrationsTest from '@convex-dev/migrations/test';
import aggregateTest from '@convex-dev/aggregate/test';
import workflowTest from '@convex-dev/workflow/test';
import actionRetrierTest from '@convex-dev/action-retrier/test';
import workpoolTest from '@convex-dev/workpool/test';
import { internal } from '@convex/_generated/api';
import schema from './schema';
import { modules } from './test.setup';
import {
	ARTIFACT_ARCHIVE_MAX_VERSIONS,
	artifactVersionsTable,
	stagingArtifactsTable,
	type ArchivePageResult
} from './lib/artifactArchive';

function stagingSchema() {
	return defineSchema({
		...schema.tables,
		artifacts: stagingArtifactsTable,
		artifactVersions: artifactVersionsTable
	});
}

function initArchiveTest() {
	const t = convexTest({ schema: stagingSchema(), modules, transactionLimits: true });
	// SAFETY: each component test helper types registerComponent against its own
	// TestConvex variance; the convex-test backend object is the same instance.
	const backend = t as never;
	rateLimiterTest.register(backend);
	contextDevTest.register(backend);
	exaTest.register(backend);
	migrationsTest.register(backend);
	aggregateTest.register(backend);
	workflowTest.register(backend);
	actionRetrierTest.register(backend);
	workpoolTest.register(backend, 'webToolWorkpool');
	return t;
}

function archiveApi() {
	return internal.artifactArchive;
}

type ArchiveTest = ReturnType<typeof initArchiveTest>;
type ThreadSeed = Awaited<ReturnType<typeof seedThread>>;

async function seedThread(t: ArchiveTest) {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('threadRecords', {
			userId: 'user_alice',
			submissionId: 'thread-archive',
			status: 'completed',
			repositoryKey: 'alpha',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			lastMessageAt: 1
		});
		const runId = await ctx.db.insert('runs', {
			threadId,
			userId: 'user_alice',
			submissionId: 'thread-archive',
			status: 'completed',
			executionSecretHash: 'fixture',
			completionAttemptSeq: 0,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			startedAt: 1,
			completedAt: 1
		});
		return { threadId, runId };
	});
}

async function insertLeftover(
	t: ArchiveTest,
	args: { threadId: ThreadSeed['threadId']; runId: ThreadSeed['runId']; currentVersion?: number }
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('artifacts', {
			threadId: args.threadId,
			userId: 'user_alice',
			title: 'Notes',
			type: 'markdown',
			currentVersion: args.currentVersion ?? 1,
			createdById: args.runId,
			createdAt: 10,
			updatedAt: 20
		});
	});
}

async function insertFileBacked(t: ArchiveTest, threadId: ThreadSeed['threadId']) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('artifacts', {
			userId: 'user_alice',
			scope: 'thread',
			repositoryKey: 'alpha',
			threadId,
			localPath: 'notes.md',
			content: '# hello',
			type: 'markdown',
			title: 'notes.md',
			revision: 1,
			createdAt: 13,
			updatedAt: 14
		});
	});
}

async function insertVersion(
	t: ArchiveTest,
	args: {
		artifactId: Awaited<ReturnType<typeof insertLeftover>>;
		version: number;
		content: string;
		createdAt?: number;
	}
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('artifactVersions', {
			artifactId: args.artifactId,
			userId: 'user_alice',
			version: args.version,
			content: args.content,
			createdAt: args.createdAt ?? 11
		});
	});
}

async function archiveUntilDone(t: ArchiveTest) {
	let cursor: string | null = null;
	let calls = 0;
	let archivedVersions = 0;
	let deletedArtifacts = 0;
	for (let i = 0; i < 32; i += 1) {
		const result: ArchivePageResult = await t.mutation(archiveApi().archiveLegacyArtifactsPage, {
			cursor
		});
		calls += 1;
		archivedVersions += result.archivedVersions;
		deletedArtifacts += result.deletedArtifacts;
		if (result.isDone) {
			return { ...result, calls, archivedVersions, deletedArtifacts };
		}
		cursor = result.continueCursor;
	}
	throw new Error('archiveLegacyArtifactsPage did not finish within the test bound.');
}

async function tableSnapshot(t: ArchiveTest) {
	return await t.run(async (ctx) => ({
		artifacts: await ctx.db.query('artifacts').take(32),
		versions: await ctx.db.query('artifactVersions').take(32),
		archived: await ctx.db.query('oldArtifacts').take(32)
	}));
}

describe('artifactArchive', () => {
	it('checks later pages for legacy metadata without exceeding read limits', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		for (let i = 0; i < 9; i += 1) await insertFileBacked(t, threadId);
		await insertLeftover(t, { threadId, runId });
		const first = await t.query(archiveApi().leftoverLegacyPresent, {});
		expect(first).toMatchObject({ leftover: false, isDone: false });
		expect(
			await t.query(archiveApi().leftoverLegacyPresent, { cursor: first.continueCursor })
		).toMatchObject({ leftover: true });
	});

	it('archives leftover versions, keeps file-backed docs, and is idle on rerun', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		const leftoverId = await insertLeftover(t, { threadId, runId, currentVersion: 2 });
		const versionIds = [
			await insertVersion(t, {
				artifactId: leftoverId,
				version: 1,
				content: '# v1',
				createdAt: 11
			}),
			await insertVersion(t, { artifactId: leftoverId, version: 2, content: '# v2', createdAt: 12 })
		];
		const fileBackedId = await insertFileBacked(t, threadId);

		expect(await t.query(archiveApi().leftoverLegacyPresent, {})).toMatchObject({ leftover: true });
		const result = await archiveUntilDone(t);
		expect(result).toMatchObject({ isDone: true, archivedVersions: 2, deletedArtifacts: 1 });

		const after = await tableSnapshot(t);
		expect(after.versions).toEqual([]);
		expect(after.artifacts.map((row) => row._id)).toEqual([fileBackedId]);
		expect(after.archived).toHaveLength(2);
		expect(after.archived.map((row) => row.legacyArtifactId)).toEqual([leftoverId, leftoverId]);
		expect(after.archived.map((row) => row.legacyVersionId).sort()).toEqual([...versionIds].sort());
		expect(after.archived.map((row) => row.content).sort()).toEqual(['# v1', '# v2']);
		expect(await t.query(archiveApi().leftoverLegacyPresent, {})).toMatchObject({
			leftover: false,
			isDone: true
		});

		const retry = await t.mutation(archiveApi().archiveLegacyArtifactsPage, { cursor: null });
		expect(retry).toMatchObject({ isDone: true, archivedVersions: 0, deletedArtifacts: 0 });
		expect((await tableSnapshot(t)).archived).toHaveLength(2);
	});

	it('spans mutations when leftover history exceeds the version bound', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		const leftoverId = await insertLeftover(t, {
			threadId,
			runId,
			currentVersion: ARTIFACT_ARCHIVE_MAX_VERSIONS + 1
		});
		for (let version = 1; version <= ARTIFACT_ARCHIVE_MAX_VERSIONS + 1; version += 1) {
			await insertVersion(t, {
				artifactId: leftoverId,
				version,
				content: `# v${version}`,
				createdAt: 10 + version
			});
		}

		const done = await archiveUntilDone(t);
		expect(done.calls).toBeGreaterThan(1);
		expect(done).toMatchObject({
			isDone: true,
			archivedVersions: ARTIFACT_ARCHIVE_MAX_VERSIONS + 1,
			deletedArtifacts: 1
		});
		const after = await tableSnapshot(t);
		expect(after.versions).toEqual([]);
		expect(after.archived).toHaveLength(ARTIFACT_ARCHIVE_MAX_VERSIONS + 1);
		expect(after.artifacts).toEqual([]);
	});

	it('advances past full file-backed pages and archives large versions within transaction limits', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		for (let i = 0; i < 10; i += 1) await insertFileBacked(t, threadId);
		const leftoverId = await insertLeftover(t, { threadId, runId, currentVersion: 9 });
		for (let version = 1; version <= 9; version += 1) {
			await insertVersion(t, { artifactId: leftoverId, version, content: 'x'.repeat(500_000) });
		}
		const result = await archiveUntilDone(t);
		expect(result).toMatchObject({ isDone: true, archivedVersions: 9, deletedArtifacts: 1 });
		expect(result.calls).toBeGreaterThan(3);
		const after = await tableSnapshot(t);
		expect(after.artifacts).toHaveLength(10);
		expect(after.versions).toEqual([]);
		expect(after.archived).toHaveLength(9);
		expect(after.archived.every((row) => row.content.length === 500_000)).toBe(true);
	});

	it('preserves duplicate leftover version numbers as distinct archive rows', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		const leftoverId = await insertLeftover(t, { threadId, runId, currentVersion: 1 });
		const firstId = await insertVersion(t, { artifactId: leftoverId, version: 1, content: '# a' });
		const secondId = await insertVersion(t, { artifactId: leftoverId, version: 1, content: '# b' });

		const result = await archiveUntilDone(t);
		expect(result).toMatchObject({ isDone: true, archivedVersions: 2, deletedArtifacts: 1 });
		const after = await tableSnapshot(t);
		expect(after.archived).toHaveLength(2);
		expect(after.archived.map((row) => row.version)).toEqual([1, 1]);
		expect(after.archived.map((row) => row.content).sort()).toEqual(['# a', '# b']);
		expect(after.archived.map((row) => row.legacyVersionId).sort()).toEqual(
			[firstId, secondId].sort()
		);
	});

	it('archives orphan versions whose leftover artifact is already gone', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		const leftoverId = await insertLeftover(t, { threadId, runId });
		const versionId = await insertVersion(t, {
			artifactId: leftoverId,
			version: 3,
			content: '# orphan'
		});
		await t.run(async (ctx) => {
			await ctx.db.delete('artifacts', leftoverId);
		});
		const fileBackedId = await insertFileBacked(t, threadId);

		const result = await archiveUntilDone(t);
		expect(result).toMatchObject({ isDone: true, archivedVersions: 1, deletedArtifacts: 0 });
		const after = await tableSnapshot(t);
		expect(after.versions).toEqual([]);
		expect(after.artifacts.map((row) => row._id)).toEqual([fileBackedId]);
		expect(after.archived).toEqual([
			expect.objectContaining({
				legacyArtifactId: leftoverId,
				legacyVersionId: versionId,
				content: '# orphan',
				title: ''
			})
		]);
	});

	it('archives metadata-only leftover artifacts that have no versions', async () => {
		const t = initArchiveTest();
		const { threadId, runId } = await seedThread(t);
		const leftoverId = await insertLeftover(t, { threadId, runId, currentVersion: 0 });

		expect(await t.query(archiveApi().leftoverLegacyPresent, {})).toMatchObject({ leftover: true });
		const result = await archiveUntilDone(t);
		expect(result).toMatchObject({ isDone: true, archivedVersions: 1, deletedArtifacts: 1 });
		const after = await tableSnapshot(t);
		expect(after.artifacts).toEqual([]);
		expect(after.archived).toEqual([
			expect.objectContaining({
				legacyArtifactId: leftoverId,
				version: 0,
				content: ''
			})
		]);
		expect(after.archived[0]).not.toHaveProperty('legacyVersionId');
	});
});
