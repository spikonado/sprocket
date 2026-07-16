import { describe, expect, it } from 'vitest';
import {
	assertSupportedModelConfiguration,
	modelDefinitions,
	modelIds,
	reasoningEffortIds,
	serviceTierIds
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

	it('matches provider model names and reasoning capabilities', () => {
		expect(
			modelDefinitions.map(({ label, reasoningEfforts, defaultReasoningEffort }) => [
				label,
				reasoningEfforts,
				defaultReasoningEffort
			])
		).toEqual([
			['GPT-5.6 Sol', reasoningEffortIds, 'medium'],
			['GPT-5.6 Terra', reasoningEffortIds, 'medium'],
			['GPT-5.6 Luna', reasoningEffortIds, 'medium'],
			['Claude Fable 5', ['low', 'medium', 'high', 'xhigh', 'max'], 'high'],
			['Grok 4.5', ['low', 'medium', 'high'], 'high']
		]);
		expect(modelDefinitions.every(({ serviceTiers }) => serviceTiers === serviceTierIds)).toBe(
			true
		);
		expect(
			modelDefinitions.every(({ reasoningEfforts, defaultReasoningEffort }) =>
				reasoningEfforts.includes(defaultReasoningEffort)
			)
		).toBe(true);
	});

	it('validates reasoning and service tiers against each model', () => {
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'gpt-5.6-sol',
				reasoningEffort: 'max',
				serviceTier: 'fast'
			})
		).not.toThrow();
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
				reasoningEffort: 'max',
				serviceTier: 'fast'
			})
		).not.toThrow();
	});
});
