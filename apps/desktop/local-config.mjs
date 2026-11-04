export const DEV_HOST = 'localhost';

export const DEV_API_HOST = '127.0.0.1';

// Must match the `serve --port` flag in scripts/run-dev.mjs.
export const DEV_API_PORT = 7731;

export const WEB_DEV_PORT = 5173;

// Must match DEFAULT_PORT in crates/sprocket-server/src/config.rs.
export const INSTALLED_APP_PORT = 17731;

export const DEV_API_URL = `http://${DEV_API_HOST}:${DEV_API_PORT}`;

export const DEV_WEB_URL = `http://${DEV_HOST}:${WEB_DEV_PORT}`;

/**
 * @param {string} currentUrl
 * @returns {string | null}
 */
export function canonicalDevWebUrl(currentUrl) {
	const url = new URL(currentUrl);

	if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
		return null;
	}

	url.hostname = DEV_HOST;

	return url.toString();
}

/**
 * @param {string} hostname
 * @param {boolean} hasDesktopBridge
 */
export function usesLoopbackBrowserAuth(hostname, hasDesktopBridge) {
	return hasDesktopBridge || ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}
