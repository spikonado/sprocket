import { browser } from '$app/environment';

export const prerender = true;
export const ssr = false;

export type RuntimeConfig = {
	env: Record<string, string>;
};

export async function load({ fetch }): Promise<RuntimeConfig> {
	if (!browser) {
		return { env: {} };
	}

	const response = await fetch('/api/config');
	if (!response.ok) {
		throw new Error('Failed to load Sprocket runtime config.');
	}

	return (await response.json()) as RuntimeConfig;
}
