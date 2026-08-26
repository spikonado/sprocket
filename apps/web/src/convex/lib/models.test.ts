import { describe, expect, it } from 'vitest';
import {
	assertSupportedModelConfiguration,
	coercePersistedReasoningEffort,
	coercePersistedModelId,
	coercePersistedSelection
} from '@convex/lib/models';
import { subscriptionTierIds, tierAllowedModels } from '@convex/lib/tiers';

describe('model configuration', () => {
	it('rejects reasoning efforts unsupported by a model', () => {
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'glm-5.3',
				reasoningEffort: 'xhigh',
				serviceTier: 'standard'
			})
		).toThrow('GLM 5.3 does not support xhigh reasoning.');
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'claude-opus-5',
				reasoningEffort: 'none',
				serviceTier: 'standard'
			})
		).toThrow('Claude Opus 5 does not support none reasoning.');
	});

	it('rejects max reasoning on closed-source models', () => {
		for (const modelId of [
			'stealth/ox-alpha',
			'gpt-5.6-sol',
			'claude-opus-5',
			'claude-fable-5'
		] as const) {
			expect(() =>
				assertSupportedModelConfiguration({
					modelId,
					reasoningEffort: 'max',
					serviceTier: 'standard'
				})
			).toThrow('does not support max reasoning.');
		}
	});

	it('coerces dropped reasoning efforts onto the model default', () => {
		expect(coercePersistedReasoningEffort('stealth/ox-alpha', 'max')).toBe('high');
		expect(coercePersistedReasoningEffort('gpt-5.6-sol', 'max')).toBe('medium');
		expect(coercePersistedReasoningEffort('claude-fable-5', 'max')).toBe('high');
		expect(coercePersistedReasoningEffort('kimi-k3', 'max')).toBe('max');
		expect(coercePersistedReasoningEffort('gpt-5.6-sol', undefined)).toBeUndefined();
	});

	it('maps retired stored models onto the current catalog', () => {
		expect(coercePersistedModelId('gpt-5.6-luna')).toBe('gpt-5.6-sol');
		expect(coercePersistedModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro-0813');
		expect(coercePersistedModelId('deepseek-v4-flash')).toBe('deepseek-v4-flash-0731');
		expect(coercePersistedModelId('kimi-k3')).toBe('kimi-k3');
		expect(coercePersistedSelection('grok-4.5', 'fast')).toEqual({
			modelId: 'gpt-5.6-sol',
			serviceTier: 'standard'
		});
		expect(coercePersistedSelection('claude-opus-5', 'fast')).toEqual({
			modelId: 'claude-opus-5',
			serviceTier: 'fast'
		});
	});

	it('offers Ox Alpha on every subscription tier', () => {
		for (const tier of subscriptionTierIds) {
			expect(tierAllowedModels[tier]).toContain('stealth/ox-alpha');
		}
	});

	it('rejects service tiers a model does not support', () => {
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'kimi-k3',
				serviceTier: 'fast'
			})
		).toThrow('Kimi K3 does not support the fast service tier.');
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'deepseek-v4-flash-0731',
				serviceTier: 'fast'
			})
		).toThrow('DeepSeek V4 Flash does not support the fast service tier.');
	});
});
