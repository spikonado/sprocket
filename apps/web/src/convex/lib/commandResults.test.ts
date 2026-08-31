import { describe, expect, it } from 'vitest';
import { removeLegacyCommandStreams } from './commandResults';

describe('removeLegacyCommandStreams', () => {
	it('removes only the duplicated command stream fields', () => {
		expect(
			removeLegacyCommandStreams('exec_command', {
				command: 'printf hello',
				cwd: '/workspace',
				stdout: 'hello',
				stderr: '',
				output: 'hello',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				truncated: false
			})
		).toEqual({
			command: 'printf hello',
			cwd: '/workspace',
			output: 'hello',
			exitCode: 0,
			success: true,
			running: false,
			timedOut: false,
			truncated: false
		});
	});

	it('leaves current and unrelated results untouched', () => {
		const current = { command: 'true', cwd: '/', output: '', success: true };
		const unrelated = { stdout: 'value', output: 'value' };
		expect(removeLegacyCommandStreams('exec_command', current)).toBe(current);
		expect(removeLegacyCommandStreams('web_search', unrelated)).toBe(unrelated);
	});
});
