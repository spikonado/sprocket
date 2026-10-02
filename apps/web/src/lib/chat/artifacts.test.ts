import { describe, expect, it } from 'vitest';
import { artifactWatchScopeKey, isCurrentArtifactsWatch } from './artifacts';

describe('artifact watch snapshots', () => {
	it('distinguishes project, workspace, and account watch scopes', () => {
		const scope = { userId: 'user-1', repositoryKey: 'repo-1', workspacePath: '/ws' };
		const key = artifactWatchScopeKey(scope);
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, workspacePath: '/other' }));
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, repositoryKey: 'repo-2' }));
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, userId: 'user-2' }));
	});

	it('ignores late events after abort, generation bump, or scope switch', () => {
		const projectScope = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/ws'
		});

		const otherScope = artifactWatchScopeKey({
			userId: 'user-1',
			repositoryKey: 'repo-1',
			workspacePath: '/other'
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
				currentScopeKey: otherScope
			})
		).toBe(false);
		expect(
			isCurrentArtifactsWatch({
				aborted: false,
				generation: 2,
				currentGeneration: 2,
				eventScopeKey: otherScope,
				currentScopeKey: otherScope
			})
		).toBe(true);
	});
});
