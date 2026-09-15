import { describe, expect, it } from 'vitest';
import { artifactWatchScopeKey, artifactsWatchRequest, isCurrentArtifactsWatch } from './artifacts';

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
