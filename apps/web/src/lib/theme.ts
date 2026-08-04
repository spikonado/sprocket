export type SprocketTheme = 'light' | 'dark';

export const DEFAULT_THEME: SprocketTheme = 'light';

export function isSprocketTheme(value: unknown): value is SprocketTheme {
	return value === 'light' || value === 'dark';
}

export function resolveTheme(preference: SprocketTheme | null | undefined): SprocketTheme {
	return preference ?? DEFAULT_THEME;
}

let entryThemeDepth = 0;
let themeBeforeEntry: SprocketTheme | null = null;

function writeTheme(theme: SprocketTheme): void {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}

export function applyTheme(theme: SprocketTheme): void {
	if (typeof document === 'undefined') {
		return;
	}

	if (entryThemeDepth > 0) {
		// Keep entry shells light; remember the preferred theme for restore.
		themeBeforeEntry = theme;
		return;
	}

	writeTheme(theme);
}

/** Force light theme for entry shells; restores the previous theme when the last shell unmounts. */
export function forceEntryTheme(): () => void {
	if (typeof document === 'undefined') {
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
