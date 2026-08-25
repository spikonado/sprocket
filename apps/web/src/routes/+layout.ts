import { browser, dev } from '$app/environment';
import { canonicalDevWebUrl } from '../../../desktop/local-config.mjs';
import { z } from 'zod';

export const prerender = true;
export const ssr = false;

export type RuntimeConfig = {
	env: Record<string, string>;
};

const runtimeConfigSchema = z.object({
	env: z.record(z.string(), z.string())
});

export async function load({ fetch }): Promise<RuntimeConfig> {
	if (!browser) {
		return { env: {} };
	}

	if (dev) {
		const canonicalUrl = canonicalDevWebUrl(window.location.href);
		if (canonicalUrl) {
			window.location.replace(canonicalUrl);
			return { env: {} };
		}
	}

	const response = await fetch('/api/config');
	if (!response.ok) {
		throw new Error('Failed to load Sprocket runtime config.');
	}

	const parsed = runtimeConfigSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error('Failed to load Sprocket runtime config.');
	}
	return parsed.data;
}
