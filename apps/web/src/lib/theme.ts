import { readStorage, writeStorage } from '$lib/storage';

export type SprocketTheme = 'light' | 'dark';

export const DEFAULT_THEME: SprocketTheme = 'light';

// The preference lives in Convex; this copy themes the shell before Convex answers.
const LAST_THEME_KEY = 'sprocket.theme';

export function isSprocketTheme(value: string | null | undefined): value is SprocketTheme {
	return value === 'light' || value === 'dark';
}

export function resolveTheme(preference: SprocketTheme | null | undefined): SprocketTheme {
	if (preference) return preference;
	const lastTheme = readStorage(LAST_THEME_KEY);

	return isSprocketTheme(lastTheme) ? lastTheme : DEFAULT_THEME;
}

let entryThemeDepth = 0;

let themeBeforeEntry: SprocketTheme | null = null;

const BROWSER_CHROME_COLOR: Record<SprocketTheme, string> = { light: '#f2f7ed', dark: '#09111a' };

function writeTheme(theme: SprocketTheme): void {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', BROWSER_CHROME_COLOR[theme]);
}

export function applyTheme(theme: SprocketTheme): void {
	if (!globalThis.document) {
		return;
	}

	writeStorage(LAST_THEME_KEY, theme);

	if (entryThemeDepth > 0) {
		themeBeforeEntry = theme;

		return;
	}

	writeTheme(theme);
}

export function forceEntryTheme(): () => void {
	if (!globalThis.document) {
		return () => {};
	}

	if (entryThemeDepth === 0) {
		themeBeforeEntry = isSprocketTheme(document.documentElement.dataset.theme)
			? document.documentElement.dataset.theme
			: resolveTheme(null);
		writeTheme('light');
	}

	entryThemeDepth += 1;

	return () => {
		entryThemeDepth = Math.max(0, entryThemeDepth - 1);

		if (entryThemeDepth === 0) {
			const restore = themeBeforeEntry ?? resolveTheme(null);
			themeBeforeEntry = null;
			writeTheme(restore);
		}
	};
}
