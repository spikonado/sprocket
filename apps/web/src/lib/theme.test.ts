import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME, applyTheme, forceEntryTheme, isSprocketTheme, resolveTheme } from './theme';

function stubDocument(theme: string | undefined = undefined) {
	const dataset: Record<string, string> = {};
	if (theme) dataset.theme = theme;
	const style: { colorScheme: string } = { colorScheme: '' };
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

	it('accepts only light and dark themes', () => {
		expect(isSprocketTheme('light')).toBe(true);
		expect(isSprocketTheme('dark')).toBe(true);
		expect(isSprocketTheme('system')).toBe(false);
		expect(isSprocketTheme(null)).toBe(false);
	});

	it('resolves an explicit preference first, otherwise the default', () => {
		expect(resolveTheme('light')).toBe('light');
		expect(resolveTheme('dark')).toBe('dark');
		expect(resolveTheme(null)).toBe(DEFAULT_THEME);
		expect(resolveTheme(undefined)).toBe(DEFAULT_THEME);
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
