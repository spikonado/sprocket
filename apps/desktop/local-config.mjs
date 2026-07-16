/** Shared local host and port settings for development and the installed app. */
export const DEV_HOST = 'localhost';
export const DEV_API_HOST = '127.0.0.1';
// Must match the `--port` flag in the root package.json `dev` script.
export const DEV_API_PORT = 7731;
export const WEB_DEV_PORT = 5173;
// Must match DEFAULT_PORT in crates/sprocket-server/src/config.rs.
export const INSTALLED_APP_PORT = 17731;
export const DEV_API_URL = `http://${DEV_API_HOST}:${DEV_API_PORT}`;
export const DEV_WEB_URL = `http://${DEV_HOST}:${WEB_DEV_PORT}`;

/**
 * Keep browser auth, pairing cookies, and PKCE state on one development origin.
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
 * Installed loopback pages and the Electron renderer use the server-mediated auth callback.
 * @param {string} hostname
 * @param {boolean} hasDesktopBridge
 * @param {boolean} isDevelopment
 */
export function usesLoopbackBrowserAuth(hostname, hasDesktopBridge, isDevelopment) {
	return (
		hasDesktopBridge || (!isDevelopment && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
	);
}
