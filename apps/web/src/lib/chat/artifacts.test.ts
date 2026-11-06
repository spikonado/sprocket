import { describe, expect, it } from 'vitest';
import { artifactWatchScopeKey } from './artifacts';

describe('artifact watch snapshots', () => {
	it('distinguishes project, workspace, and account watch scopes', () => {
		const scope = { userId: 'user-1', repositoryKey: 'repo-1', workspacePath: '/ws' };
		const key = artifactWatchScopeKey(scope);
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, workspacePath: '/other' }));
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, repositoryKey: 'repo-2' }));
		expect(key).not.toBe(artifactWatchScopeKey({ ...scope, userId: 'user-2' }));
	});
});
