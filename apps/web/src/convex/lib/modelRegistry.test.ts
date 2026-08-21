import { describe, expect, it, vi } from 'vitest';
import { FallbackModel } from 'ai-fallback';
import {
	createProviderFetch,
	hasBedrockCredentials,
	resolveLanguageModel,
	resolveProviderOptions
} from '@convex/lib/modelRegistry';

describe('model provider request configuration', () => {
	it('enables provider-native prompt caching controls', () => {
		expect(resolveProviderOptions('claude-fable-5', undefined, 'standard', 'thread:abc')).toEqual({
			anthropic: { cacheControl: { type: 'ephemeral' } }
		});
		expect(resolveProviderOptions('gpt-5.6-sol', 'high', 'standard', 'thread:abc')).toEqual({
			openai: {
				reasoningEffort: 'high',
				serviceTier: 'default',
				promptCacheKey: 'thread:abc',
				promptCacheOptions: { mode: 'implicit', ttl: '30m' }
			}
		});
		expect(resolveProviderOptions('kimi-k3', 'max', 'standard', 'thread:abc')).toEqual({
			fireworks: {
				reasoningEffort: 'max',
				promptCacheKey: 'thread:abc',
				reasoningHistory: 'interleaved'
			}
		});
		expect(resolveProviderOptions('deepseek-v4-pro', 'max', 'standard', 'thread:abc')).toEqual({
			fireworks: {
				reasoningEffort: 'max',
				promptCacheKey: 'thread:abc',
				reasoningHistory: 'interleaved'
			}
		});
		expect(resolveProviderOptions('glm-5.3', 'max', 'standard', 'thread:abc')).toEqual({
			zai: { reasoningEffort: 'max' }
		});
	});

	it('adds Anthropic service_tier only to completion request bodies', async () => {
		const bodies: unknown[] = [];
		const fetch = createProviderFetch({ serviceTier: 'standard_only' }, async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('{}');
		});

		await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			body: JSON.stringify({ model: 'claude-fable-5' })
		});
		await fetch('https://api.anthropic.com/v1/models', {
			method: 'POST',
			body: JSON.stringify({ model: 'claude-fable-5' })
		});

		expect(bodies).toEqual([
			{ model: 'claude-fable-5', service_tier: 'standard_only' },
			{ model: 'claude-fable-5' }
		]);
	});
});

describe('Amazon Bedrock fallback routing', () => {
	it('detects Bedrock credentials from bearer token or SigV4 keys', () => {
		expect(hasBedrockCredentials({})).toBe(false);
		expect(hasBedrockCredentials({ AWS_BEARER_TOKEN_BEDROCK: 'token' })).toBe(true);
		expect(
			hasBedrockCredentials({
				AWS_ACCESS_KEY_ID: 'AKIA...',
				AWS_SECRET_ACCESS_KEY: 'secret'
			})
		).toBe(true);
		expect(hasBedrockCredentials({ AWS_ACCESS_KEY_ID: 'AKIA...' })).toBe(false);
	});

	it('wraps OpenAI and Anthropic models only when Bedrock credentials are set', () => {
		vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');
		vi.stubEnv('AWS_ACCESS_KEY_ID', '');
		vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');

		expect(resolveLanguageModel('gpt-5.6-sol', 'standard')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('claude-opus-5', 'standard')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('claude-fable-5', 'standard')).not.toBeInstanceOf(FallbackModel);

		vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'test-bedrock-token');
		const openaiFallback = resolveLanguageModel('gpt-5.6-sol', 'standard');
		const opusFallback = resolveLanguageModel('claude-opus-5', 'standard');
		const fableFallback = resolveLanguageModel('claude-fable-5', 'standard');
		expect(openaiFallback).toBeInstanceOf(FallbackModel);
		expect(opusFallback).toBeInstanceOf(FallbackModel);
		expect(fableFallback).toBeInstanceOf(FallbackModel);
		expect(openaiFallback).toMatchObject({
			retryAfterOutput: false,
			settings: {
				models: [{ modelId: 'gpt-5.6-sol' }, { modelId: 'openai.gpt-5.6-sol' }]
			}
		});
		expect(opusFallback).toMatchObject({
			settings: {
				models: [{ modelId: 'claude-opus-5' }, { modelId: 'us.anthropic.claude-opus-5' }]
			}
		});
		expect(fableFallback).toMatchObject({
			settings: {
				models: [{ modelId: 'claude-fable-5' }, { modelId: 'us.anthropic.claude-fable-5' }]
			}
		});
		expect(resolveLanguageModel('claude-opus-5', 'fast')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('claude-fable-5', 'fast')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('gpt-5.6-sol', 'fast')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('glm-5.3', 'standard')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('kimi-k3', 'standard')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('deepseek-v4-pro', 'standard')).not.toBeInstanceOf(FallbackModel);
		expect(resolveLanguageModel('kimi-k3', 'standard')).toMatchObject({
			modelId: 'accounts/fireworks/models/kimi-k3'
		});
		expect(resolveLanguageModel('deepseek-v4-flash', 'standard')).toMatchObject({
			modelId: 'accounts/fireworks/models/deepseek-v4-flash'
		});
		expect(resolveLanguageModel('glm-5.3', 'standard')).toMatchObject({
			modelId: 'glm-5.3'
		});

		const shouldRetry = (openaiFallback as FallbackModel).settings.shouldRetryThisError!;
		expect(shouldRetry(Object.assign(new Error('auth'), { statusCode: 401 }))).toBe(false);
		expect(
			shouldRetry(Object.assign(new Error('auth'), { cause: { response: { status: 403 } } }))
		).toBe(false);
		expect(shouldRetry(new Error('Incorrect API key provided'))).toBe(false);
		expect(shouldRetry(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true);

		vi.unstubAllEnvs();
	});
});
