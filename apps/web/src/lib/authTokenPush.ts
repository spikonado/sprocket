import { resolveDesktopApi } from '$lib/local/client';
import type { DesktopApi, SessionCredentialSeed } from '$lib/types/sprocket';

let desktopApiPromise: Promise<DesktopApi> | null = null;

/** Shared lazy resolution of the local Sprocket server client. Failed
 * resolutions are forgotten so callers can retry once the server is up. */
export function getDesktopApi(): Promise<DesktopApi> {
	if (!desktopApiPromise) {
		desktopApiPromise = resolveDesktopApi().catch((error) => {
			desktopApiPromise = null;
			throw error;
		});
	}
	return desktopApiPromise;
}

/**
 * Best-effort push of a freshly minted WorkOS access token to the local
 * server, which forwards it to Convex when its own auth token is expiring.
 * Failures are safe to ignore: the server keeps serving its last cached
 * token as a fallback.
 */
export async function pushConvexToken(token: string): Promise<void> {
	if (!token) {
		return;
	}
	try {
		const api = await getDesktopApi();
		await api.pushConvexToken(token);
	} catch {
		// No local server (or not paired yet): nothing to push to.
	}
}

export async function pushSessionCredential(credential: SessionCredentialSeed): Promise<void> {
	const api = await getDesktopApi();
	await api.pushSessionCredential(credential);
}
