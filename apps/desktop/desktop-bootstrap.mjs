export function parseDesktopBootstrap(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}
	if (typeof value.httpBaseUrl !== 'string') {
		return null;
	}
	const httpBaseUrl = value.httpBaseUrl.trim();
	if (httpBaseUrl.length === 0) {
		return null;
	}
	return { httpBaseUrl };
}
