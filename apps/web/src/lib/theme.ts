export type SprocketTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sprocket-theme';
export const DEFAULT_THEME: SprocketTheme = 'dark';

export function isSprocketTheme(value: unknown): value is SprocketTheme {
	return value === 'light' || value === 'dark';
}

export function readStoredTheme(): SprocketTheme | null {
	if (typeof localStorage === 'undefined') {
		return null;
	}

	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return isSprocketTheme(stored) ? stored : null;
	} catch {
		return null;
	}
}

export function resolveTheme(preference: SprocketTheme | null | undefined): SprocketTheme {
	return preference ?? readStoredTheme() ?? DEFAULT_THEME;
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

export function persistTheme(theme: SprocketTheme): void {
	applyTheme(theme);

	if (typeof localStorage === 'undefined') {
		return;
	}

	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Ignore quota / private-mode failures; in-memory theme still applies.
	}
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
