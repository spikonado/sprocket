import { expect, it } from 'vitest';
import { reorderShownProviders } from './providers';

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
