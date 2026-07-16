import { describe, expect, it } from 'vitest';
import { createServiceTierFetch, resolveProviderOptions } from '@convex/lib/modelRegistry';

describe('model registry', () => {
	it.each(['standard_only', 'auto', 'priority'] as const)(
		'adds the %s service tier to request bodies',
		async (serviceTier) => {
			let requestBody: BodyInit | null | undefined;
			const baseFetch: typeof fetch = async (_input, init) => {
				requestBody = init?.body;
				return new Response();
			};
			const tierFetch = createServiceTierFetch(serviceTier, baseFetch);

			await tierFetch('https://provider.example/v1/messages', {
				method: 'POST',
				body: JSON.stringify({ model: 'test-model' })
			});

			expect(JSON.parse(String(requestBody))).toEqual({
				model: 'test-model',
				service_tier: serviceTier
			});
		}
	);

	it('leaves non-inference provider requests unchanged', async () => {
		let requestInit: RequestInit | undefined;
		const tierFetch = createServiceTierFetch('priority', async (_input, init) => {
			requestInit = init;
			return new Response();
		});

		await tierFetch('https://provider.example/v1/models', { method: 'GET' });

		expect(requestInit).toEqual({ method: 'GET' });
	});

	it('maps the shared fast tier to OpenAI priority processing', () => {
		expect(resolveProviderOptions('gpt-5.6-sol', 'medium', 'fast')).toEqual({
			openai: { reasoningEffort: 'medium', serviceTier: 'priority' }
		});
	});
});
