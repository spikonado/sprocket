import { describe, expect, it } from 'vitest';

import { buildWorkspaceInstructions } from '@convex/lib/workspacePrompt';

describe('buildWorkspaceInstructions', () => {
	it('embeds preloaded AGENTS instructions in codex-style format', () => {
		const instructions = buildWorkspaceInstructions({
			workspacePath: '/repo/packages/app',
			workspaceOverview: {
				rootPath: '/repo/packages/app',
				name: 'app',
				gitBranch: 'main',
				gitDirty: true,
				fileCount: 42,
				directoryCount: 9,
				topLevelEntries: [{ name: 'src', kind: 'directory' }],
				recentFiles: ['src/index.ts']
			},
			workspaceInstructions: [
				{
					path: '/repo/AGENTS.md',
					directory: '/repo',
					contents: 'root instructions',
					truncated: false
				},
				{
					path: '/repo/packages/app/AGENTS.md',
					directory: '/repo/packages/app',
					contents: 'nested instructions',
					truncated: false
				}
			]
		});

		expect(instructions).toContain('AGENTS.md spec:');
		expect(instructions).toContain(
			'Persist until the task is fully handled end-to-end when feasible.'
		);
		expect(instructions).toContain(
			'Do not try to fix unrelated bugs, broken tests, or unrelated files unless the user asked for that work.'
		);
		expect(instructions).toContain(
			'Validate your work when the repo has relevant tests or build checks.'
		);
		expect(instructions).toContain('# AGENTS.md instructions for /repo/packages/app');
		expect(instructions).toContain(
			'<INSTRUCTIONS>\nroot instructions\n\nnested instructions\n</INSTRUCTIONS>'
		);
	});
});
