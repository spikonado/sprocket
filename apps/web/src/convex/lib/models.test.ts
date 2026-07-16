import { describe, expect, it } from 'vitest';
import { assertSupportedModelConfiguration, modelIds } from '@convex/lib/models';

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
});
