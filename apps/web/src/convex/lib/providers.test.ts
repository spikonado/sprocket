import { describe, expect, it } from 'vitest';
import {
	completionProviders,
	normalizeProviderPreference,
	parseChatGPTAuth
} from '@convex/lib/providers';

describe('provider helpers', () => {
	it('fills missing providers while preserving caller order', () => {
		expect(normalizeProviderPreference(['openai'])).toEqual(['openai', 'convex', 'chatgpt']);
		expect(normalizeProviderPreference(['convex', 'openai', 'openai'])).toEqual([
			'convex',
			'openai',
			'chatgpt'
		]);
		expect(normalizeProviderPreference(undefined)).toEqual([...completionProviders]);
	});

	it('parses ChatGPT auth.json', () => {
		const { authJson, keyHint } = parseChatGPTAuth(
			JSON.stringify({
				access_token: 'atok-abcdefghijklmnopqrstuvwxyz',
				refresh_token: 'rtok-1234567890abcdef',
				account_id: 'acc-xyz9'
			})
		);
		expect(keyHint).toBe('xyz9');
		expect(JSON.parse(authJson)).toMatchObject({
			access_token: 'atok-abcdefghijklmnopqrstuvwxyz',
			refresh_token: 'rtok-1234567890abcdef',
			account_id: 'acc-xyz9'
		});
		expect(() => parseChatGPTAuth('{')).toThrow(/JSON object/);
		expect(() => parseChatGPTAuth('{}')).toThrow(/access_token or refresh_token/);
	});
});
