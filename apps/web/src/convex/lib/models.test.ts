import { describe, expect, it } from 'vitest';
import { assertSupportedModelConfiguration } from '@convex/lib/models';

describe('model configuration', () => {
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
				modelId: 'claude-opus-5',
				reasoningEffort: 'none',
				serviceTier: 'standard'
			})
		).toThrow('Claude Opus 5 does not support none reasoning.');
	});
});
