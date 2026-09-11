import { describe, expect, it } from 'vitest';
import {
	artifactWatchScopeKey,
	artifactsWatchRequest,
	isCurrentArtifactsWatch,
	nextArtifactRevisionWatch,
	type ArtifactRevision
} from './artifacts';

function revision(
	id: string,
	currentVersion: number,
	updatedAt: number,
	content = id,
	localPath = `${id}.md`
): ArtifactRevision {
	return { id, currentVersion, updatedAt, content, localPath };
}

describe('nextArtifactRevisionWatch', () => {
	it('seeds without reporting a change on first observation', () => {
		const current = [revision('a', 1, 10), revision('b', 2, 20)];
		const { revisions, changedId } = nextArtifactRevisionWatch(null, current);

		expect(changedId).toBeNull();
		expect([...revisions.keys()]).toEqual(['a', 'b']);
	});

	it('reports a newly created artifact', () => {
		const previous = new Map([['a', revision('a', 1, 10)]]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 10),
			revision('b', 1, 30)
		]);

		expect(changedId).toBe('b');
	});

	it('does not report a second change when the cloud acknowledges the local content', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 10),
			revision('b', 2, 40)
		]);

		expect(changedId).toBeNull();
	});

	it('reports a local content change before the cloud revision bumps', () => {
		const previous = new Map([['a', revision('a', 1, 10, 'hello')]]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 40, 'hello from disk')
		]);

		expect(changedId).toBe('a');
	});

	it('reports a local path change at the same revision', () => {
		const previous = new Map([['a', revision('a', 1, 10, 'hello', 'a.md')]]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 40, 'hello', 'renamed.md')
		]);

		expect(changedId).toBe('a');
	});

	it('picks the most recently updated artifact when several change', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 2, 50, 'new a'),
			revision('b', 2, 45, 'new b')
		]);

		expect(changedId).toBe('a');
	});

	it('ignores removals and updatedAt-only noise', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId, revisions } = nextArtifactRevisionWatch(previous, [revision('a', 1, 99)]);

		expect(changedId).toBeNull();
		expect([...revisions.keys()]).toEqual(['a']);
	});
});

describe('artifact watch snapshots', () => {
	it('omits threadId from the request until a thread is selected', () => {
		expect(
			artifactsWatchRequest({
				userId: 'user-1',
				repositoryKey: 'repo-1',
				workspacePath: '/ws'
			})
		).toEqual({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws'
		});
		expect(
			artifactsWatchRequest({
				userId: 'user-1',
				repositoryKey: 'repo-1',
				workspacePath: '/ws',
				threadId: 'thread-1'
			}).threadId
		).toBe('thread-1');
	});

	it('distinguishes project and thread watch scopes', () => {
		const project = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws'
		});
		const thread = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws',
			threadId: 'thread-1'
		});
		const otherWorkspace = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/other'
		});

		expect(project).not.toBe(thread);
		expect(project).not.toBe(otherWorkspace);
	});

	it('ignores late events after abort, generation bump, or scope switch', () => {
		const projectScope = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws'
		});
		const threadScope = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws',
			threadId: 'thread-1'
		});

		expect(
			isCurrentArtifactsWatch({
				aborted: true,
				generation: 1,
				currentGeneration: 1,
				eventScopeKey: projectScope,
				currentScopeKey: projectScope
			})
		).toBe(false);
		expect(
			isCurrentArtifactsWatch({
				aborted: false,
				generation: 1,
				currentGeneration: 2,
				eventScopeKey: projectScope,
				currentScopeKey: projectScope
			})
		).toBe(false);
		expect(
			isCurrentArtifactsWatch({
				aborted: false,
				generation: 2,
				currentGeneration: 2,
				eventScopeKey: projectScope,
				currentScopeKey: threadScope
			})
		).toBe(false);
		expect(
			isCurrentArtifactsWatch({
				aborted: false,
				generation: 2,
				currentGeneration: 2,
				eventScopeKey: threadScope,
				currentScopeKey: threadScope
			})
		).toBe(true);
	});
});
