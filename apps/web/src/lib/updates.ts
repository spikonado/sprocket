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
			return 'Update installed';
		case 'error':
			return state.version ? 'Retry update' : null;
		default:
			return null;
	}
}

export async function requestPackageUpdate(install: boolean): Promise<UpdateState | null> {
	const baseUrl = resolveLocalApiBaseUrl();
	if (!baseUrl) return null;
	const response = await fetch(`${baseUrl}/api/update${install ? '/install' : ''}`, {
		method: install ? 'POST' : 'GET',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		signal: AbortSignal.timeout(30_000)
	});
	if (!install && response.status === 404) return null;
	if (!response.ok) {
		const error = z
			.object({ error: z.string() })
			.safeParse(await response.json().catch(() => null));
		throw new Error(
			error.success ? error.data.error : `Update request failed (${response.status}). Try again.`
		);
	}
	return updateStateSchema.parse(await response.json());
}
