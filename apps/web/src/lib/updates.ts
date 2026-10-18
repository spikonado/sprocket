import { z } from 'zod';
import { resolveLocalApiBaseUrl } from '$lib/local/client';

export const updateStateSchema = z.object({
	method: z.enum(['desktop', 'package']),
	status: z.enum([
		'unavailable',
		'idle',
		'checking',
		'available',
		'downloading',
		'downloaded',
		'installing',
		'installed',
		'error'
	]),
	currentVersion: z.string(),
	version: z.string().nullable(),
	progress: z.number().nullable().optional(),
	error: z.string().nullable(),
	message: z.string().nullable().optional()
});

export type UpdateState = z.infer<typeof updateStateSchema>;

export type DesktopUpdates = {
	getState: () => Promise<UpdateState>;
	download: () => Promise<UpdateState>;
	install: () => Promise<UpdateState>;
	onState: (callback: (state: UpdateState) => void) => () => void;
};

export function updateLabel(state: UpdateState): string | null {
	switch (state.status) {
		case 'available':
			return 'Update available';
		case 'downloading':
			return state.progress == null ? 'Downloading update…' : `Downloading… ${state.progress}%`;
		case 'downloaded':
			return 'Restart to update';
		case 'installing':
			return 'Installing update…';
		case 'installed':
			return 'Restart Sprocket';
		case 'error':
			return state.version ? 'Retry update' : null;
		default:
			return null;
	}
}

async function updateApiRequest(baseUrl: string, path: string, method: 'GET' | 'POST') {
	const response = await fetch(`${baseUrl}/api/update${path}`, {
		method,
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		signal: AbortSignal.timeout(30_000)
	});

	if (!response.ok) {
		const error = z
			.object({ error: z.string() })
			.safeParse(await response.json().catch(() => null));

		throw new Error(
			error.success ? error.data.error : `Update request failed (${response.status}). Try again.`
		);
	}

	return response;
}

export async function requestPackageUpdate(install: boolean): Promise<UpdateState | null> {
	const baseUrl = resolveLocalApiBaseUrl();

	if (!baseUrl) return null;

	const response = await updateApiRequest(
		baseUrl,
		install ? '/install' : '',
		install ? 'POST' : 'GET'
	);

	return updateStateSchema.parse(await response.json());
}

export async function restartPackageUpdate(version: string): Promise<void> {
	const baseUrl = resolveLocalApiBaseUrl();

	if (!baseUrl) throw new Error('The Sprocket server is unavailable.');

	await updateApiRequest(baseUrl, '/restart', 'POST');

	const deadline = Date.now() + 90_000;
	const healthSchema = z.object({ version: z.string() });

	while (Date.now() < deadline) {
		try {
			const health = await fetch(`${baseUrl}/api/health`, {
				cache: 'no-store',
				signal: AbortSignal.timeout(2_000)
			});

			if (health.ok) {
				const next = healthSchema.safeParse(await health.json());

				if (next.success && next.data.version === version) {
					window.location.reload();

					return;
				}
			}
		} catch {
			// Connection failures are expected while the server restarts.
		}

		await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
	}

	throw new Error(
		'Sprocket did not restart in time. Launch Sprocket again, then reload this page.'
	);
}
