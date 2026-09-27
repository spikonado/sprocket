import { z } from 'zod';

const runtimeConfigSchema = z.object({
	env: z.record(z.string(), z.string()),
	machine: z.boolean().optional().default(false)
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export async function loadRuntimeConfig(fetchConfig: typeof fetch = fetch): Promise<RuntimeConfig> {
	const response = await fetchConfig('/api/config');
	if (!response.ok) throw new Error('Failed to load Sprocket runtime config.');
	const parsed = runtimeConfigSchema.safeParse(await response.json());
	if (!parsed.success) throw new Error('Failed to load Sprocket runtime config.');
	return parsed.data;
}
