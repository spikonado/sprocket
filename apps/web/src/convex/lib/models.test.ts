import { describe, expect, it } from 'vitest';
import {
	coercePersistedModelId,
	coercePersistedReasoningEffort,
	coercePersistedSelection
} from '@convex/lib/models';

describe('model configuration', () => {
	it('preserves active model ids that were previously retired', () => {
		expect(coercePersistedModelId('gpt-5.6-luna')).toBe('gpt-5.6-luna');
	});

	it('maps retired stored models onto current ids', () => {
		expect(coercePersistedModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro-0813');
		expect(coercePersistedModelId('deepseek-v4-flash')).toBe('deepseek-v4-flash-0731');
		expect(coercePersistedModelId('stealth/ox-alpha')).toBe('deepseek-v4-pro-0813');
		expect(coercePersistedModelId('kimi-k3')).toBe('kimi-k3');
		expect(coercePersistedModelId('gateway-only-model')).toBe('gateway-only-model');
		expect(coercePersistedSelection('grok-4.5', 'fast')).toEqual({
			modelId: 'gpt-5.6-sol',
			serviceTier: 'fast'
		});
		expect(coercePersistedSelection('claude-opus-5', 'fast')).toEqual({
			modelId: 'claude-opus-5',
			serviceTier: 'fast'
		});
		expect(coercePersistedSelection('gateway-only-model', 'fast')).toEqual({
			modelId: 'gateway-only-model',
			serviceTier: 'fast'
		});
	});

	it('keeps stored reasoning effort when it is still a known id', () => {
		expect(coercePersistedReasoningEffort('gpt-5.6-sol', 'max')).toBe('max');
		expect(coercePersistedReasoningEffort('claude-opus-5', 'high')).toBe('high');
		expect(coercePersistedReasoningEffort('kimi-k3', 'max')).toBe('max');
	});
});
