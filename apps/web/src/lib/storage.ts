/** Browsers can deny storage access while still running the app, so these never throw. */
export function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStorage(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// The value only lasts for this session.
	}
}
