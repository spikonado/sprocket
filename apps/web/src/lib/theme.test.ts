import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, forceEntryTheme } from './theme';

function stubDocument(theme: string | undefined = undefined) {
	const dataset: Record<string, string> = {};
	if (theme) dataset.theme = theme;
	const style = { colorScheme: '' };
	vi.stubGlobal('document', {
		documentElement: { dataset, style }
	});
	return { dataset, style };
}

describe('theme helpers', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('parks applyTheme while entry theme is forced, then restores on last release', () => {
		const { dataset, style } = stubDocument('dark');
		const releaseA = forceEntryTheme();
		const releaseB = forceEntryTheme();

		try {
			expect(dataset.theme).toBe('light');
			expect(style.colorScheme).toBe('light');

			applyTheme('dark');
			expect(dataset.theme).toBe('light');

			applyTheme('light');
			expect(dataset.theme).toBe('light');

			releaseA();
			expect(dataset.theme).toBe('light');

			releaseB();
			expect(dataset.theme).toBe('light');
			expect(style.colorScheme).toBe('light');
		} finally {
			releaseA();
			releaseB();
		}
	});
});
