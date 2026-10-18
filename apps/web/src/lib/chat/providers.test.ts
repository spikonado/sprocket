import { expect, it } from 'vitest';
import { providersForModel, reorderShownProviders, usableProviders } from './providers';

it('orders usable providers by preference and skips disabled or unconfigured ones', () => {
	const providers = usableProviders(
		[
			{ provider: 'chatgpt', enabled: true },
			{ provider: 'openai', enabled: false },
			{ provider: 'spikonado', enabled: true }
		],
		['spikonado', 'openai', 'chatgpt']
	);

	expect(providers).toEqual(['chatgpt', 'spikonado']);
	expect(usableProviders(undefined, ['spikonado', 'chatgpt'])).toEqual(['spikonado', 'chatgpt']);
});

it('keeps only providers that serve the model vendor', () => {
	const providers = ['chatgpt', 'spikonado', 'openai'] as const;

	expect(providersForModel(providers, { provider: 'openai' })).toEqual([
		'chatgpt',
		'spikonado',
		'openai'
	]);
	expect(providersForModel(providers, { provider: 'anthropic' })).toEqual(['spikonado']);
	expect(providersForModel(['openai'], { provider: 'anthropic' })).toEqual([]);
	expect(providersForModel(providers, undefined)).toEqual([]);
});

it('reorders shown providers around hidden ones', () => {
	const order = [
		{ provider: 'spikonado', enabled: true },
		{ provider: 'chatgpt', enabled: false },
		{ provider: 'openai', enabled: true }
	] as const;

	expect(reorderShownProviders(order, ['openai', 'spikonado'])).toEqual([
		{ provider: 'openai', enabled: true },
		{ provider: 'chatgpt', enabled: false },
		{ provider: 'spikonado', enabled: true }
	]);
});
