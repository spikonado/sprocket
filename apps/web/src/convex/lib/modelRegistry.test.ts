import { describe, expect, it } from 'vitest';
import { createProviderFetch, resolveProviderOptions } from '@convex/lib/modelRegistry';

describe('model provider request configuration', () => {
	it('enables provider-native prompt caching controls', () => {
		expect(resolveProviderOptions('claude-fable-5', undefined, 'standard', 'thread:abc')).toEqual({
			anthropic: { cacheControl: { type: 'ephemeral' } }
		});
		expect(resolveProviderOptions('gpt-5.6-sol', 'high', 'fast', 'thread:abc')).toEqual({
			openai: {
				reasoningEffort: 'high',
				serviceTier: 'priority',
				promptCacheKey: 'thread:abc',
				promptCacheOptions: { mode: 'implicit', ttl: '30m' }
			}
		});
	});

	it('adds xAI prompt cache routing only to Responses API requests', async () => {
		const bodies: unknown[] = [];
		const fetch = createProviderFetch({ promptCacheKey: 'thread:abc' }, async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('{}');
		});

		await fetch('https://api.x.ai/v1/responses', {
			method: 'POST',
			body: JSON.stringify({ model: 'grok-4.5' })
		});
		await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			body: JSON.stringify({ model: 'claude-fable-5' })
		});

		expect(bodies).toEqual([
			{
				model: 'grok-4.5',
				prompt_cache_key: 'thread:abc'
			},
			{ model: 'claude-fable-5' }
		]);
	});
});
