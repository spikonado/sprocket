import { describe, expect, it } from 'vitest';
import {
	assertSupportedModelConfiguration,
	completionUsageUnits,
	getModelDefinition,
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

	it('uses the coding-agent context and compaction budgets', () => {
		expect(getModelDefinition('gpt-5.6-sol')).toMatchObject({
			contextWindowTokens: 258_400,
			autoCompactTokenLimit: 244_800
		});
		expect(getModelDefinition('gpt-5.6-terra').contextWindowTokens).toBe(258_400);
		expect(getModelDefinition('gpt-5.6-luna').contextWindowTokens).toBe(258_400);
		expect(getModelDefinition('claude-fable-5')).toMatchObject({
			contextWindowTokens: 980_000,
			autoCompactTokenLimit: 967_000
		});
		expect(getModelDefinition('grok-4.5')).toMatchObject({
			contextWindowTokens: 500_000,
			autoCompactTokenLimit: 400_000
		});
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

	it('weights usage by service tier and context length', () => {
		const shortUsage = { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 100_000 };
		expect(completionUsageUnits('gpt-5.6-sol', 'fast', shortUsage)).toBeGreaterThan(
			completionUsageUnits('gpt-5.6-sol', 'standard', shortUsage)
		);

		// Long-context requests are billed at higher per-token rates, so doubling
		// the input across the threshold more than doubles the charged units.
		const inputOnly = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: 0 });
		expect(completionUsageUnits('gpt-5.6-sol', 'standard', inputOnly(400_000))).toBeGreaterThan(
			2 * completionUsageUnits('gpt-5.6-sol', 'standard', inputOnly(200_000))
		);

		const grokLongUsage = { input: 200_000, cacheRead: 0, cacheWrite: 0, output: 100_000 };
		expect(completionUsageUnits('grok-4.5', 'fast', grokLongUsage)).toBeGreaterThan(
			completionUsageUnits('grok-4.5', 'standard', grokLongUsage)
		);
	});
});
