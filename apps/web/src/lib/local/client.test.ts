import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceLaunchFromHash, workspaceLaunchHash } from '$lib/local/client';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('workspace launch fragments', () => {
	it('round-trips paths containing URL metacharacters', () => {
		const workspacePath = '/robots/arm & gripper';
		const hash = workspaceLaunchHash(workspacePath);
		vi.stubGlobal('window', { location: { hash } });

		expect(hash).toBe('#workspace=%2Frobots%2Farm+%26+gripper');
		expect(readWorkspaceLaunchFromHash()).toBe(workspacePath);
	});
});
