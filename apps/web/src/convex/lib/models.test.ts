import { describe, expect, it } from 'vitest';
import {
	assertSupportedModelConfiguration,
	completionUsageUnits,
	modelIds
} from '@convex/lib/models';

describe('model configuration', () => {
	it('exposes only the configured GPT-5.6, Fable, and Grok models', () => {
		expect(modelIds).toEqual([
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
			'claude-fable-5',
			'grok-4.5'
		]);
	});

	it('rejects reasoning efforts unsupported by a model', () => {
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'grok-4.5',
				reasoningEffort: 'xhigh',
				serviceTier: 'standard'
			})
		).toThrow('Grok 4.5 does not support xhigh reasoning.');
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'claude-fable-5',
				reasoningEffort: 'none',
				serviceTier: 'standard'
			})
		).toThrow('Claude Fable 5 does not support none reasoning.');
	});

	it('prices service tiers and long contexts', () => {
		const shortUsage = { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 100_000 };
		expect(completionUsageUnits('gpt-5.6-sol', 'standard', shortUsage)).toBe(3_500);
		expect(completionUsageUnits('gpt-5.6-sol', 'fast', shortUsage)).toBe(7_000);
		expect(
			completionUsageUnits('gpt-5.6-sol', 'standard', {
				input: 300_000,
				cacheRead: 0,
				cacheWrite: 0,
				output: 100_000
			})
		).toBe(7_500);

		const grokLongUsage = { input: 200_000, cacheRead: 0, cacheWrite: 0, output: 100_000 };
		expect(completionUsageUnits('grok-4.5', 'standard', grokLongUsage)).toBe(2_000);
		expect(completionUsageUnits('grok-4.5', 'fast', grokLongUsage)).toBe(4_000);
	});
});
