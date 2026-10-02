export function shouldDenyUntrustedNavigation(url, rendererOrigin) {
	try {
		return new URL(url).origin !== rendererOrigin;
	} catch {
		return true;
	}
}
