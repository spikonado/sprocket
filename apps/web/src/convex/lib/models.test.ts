import { describe, expect, it } from 'vitest';
import {
	assertSupportedModelConfiguration,
	coercePersistedModelId,
	coercePersistedSelection,
	getModelDefinition,
	modelDefinitions,
	modelIds,
	persistedModelIds
} from '@convex/lib/models';

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

	it('keeps retired models out of the offered catalog', () => {
		const offered = modelIds as readonly string[];
		expect(offered).not.toContain('gpt-5.6-luna');
		expect(offered).not.toContain('gpt-5.6-terra');
		expect(offered).not.toContain('grok-4.5');
		expect(modelDefinitions.map((model) => model.id)).toEqual([...modelIds]);
		expect(persistedModelIds as readonly string[]).toEqual(
			expect.arrayContaining(['gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.5'])
		);
		expect(coercePersistedModelId('gpt-5.6-luna')).toBe('gpt-5.6-sol');
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

	it('labels models by lab, not inference host', () => {
		expect(getModelDefinition('deepseek-v4-pro').provider).toBe('deepseek');
		expect(getModelDefinition('deepseek-v4-flash').provider).toBe('deepseek');
		expect(getModelDefinition('kimi-k3').provider).toBe('kimi');
		expect(getModelDefinition('glm-5.3').provider).toBe('zai');
	});

	it('does not advertise Fast for models without a faster route', () => {
		expect(getModelDefinition('gpt-5.6-sol').serviceTiers).toEqual(['standard']);
		expect(getModelDefinition('claude-fable-5').serviceTiers).toEqual(['standard']);
		expect(getModelDefinition('kimi-k3').serviceTiers).toEqual(['standard']);
		expect(getModelDefinition('glm-5.3').serviceTiers).toEqual(['standard']);
		expect(getModelDefinition('deepseek-v4-pro').serviceTiers).toEqual(['standard']);
		expect(getModelDefinition('deepseek-v4-flash').serviceTiers).toEqual(['standard']);
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'kimi-k3',
				serviceTier: 'fast'
			})
		).toThrow('Kimi K3 does not support the fast service tier.');
		expect(() =>
			assertSupportedModelConfiguration({
				modelId: 'deepseek-v4-flash',
				serviceTier: 'fast'
			})
		).toThrow('DeepSeek V4 Flash does not support the fast service tier.');
	});
});
