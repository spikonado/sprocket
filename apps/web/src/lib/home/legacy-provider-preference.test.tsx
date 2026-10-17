import { beforeEach, expect, it, vi } from 'vitest';
import { migrateLegacyProviderPreference } from './legacy-provider-preference';

const key = 'sprocket.composer.provider:alice';

beforeEach(() => localStorage.clear());

it('moves a legacy BYOK/BYOS choice to the front of the provider order', async () => {
	localStorage.setItem(key, 'chatgpt');
	const save = vi.fn().mockResolvedValue(null);

	migrateLegacyProviderPreference('alice', null, save);

	expect(save).toHaveBeenCalledWith({
		providerOrder: [
			{ provider: 'chatgpt', enabled: true },
			{ provider: 'spikonado', enabled: true },
			{ provider: 'openai', enabled: true }
		]
	});
	await vi.waitFor(() => expect(localStorage.getItem(key)).toBeNull());
});

it('drops the legacy key without saving when there is nothing to migrate', () => {
	const save = vi.fn();
	localStorage.setItem(key, 'spikonado');
	migrateLegacyProviderPreference('alice', null, save);
	expect(localStorage.getItem(key)).toBeNull();

	localStorage.setItem(key, 'openai');
	migrateLegacyProviderPreference(
		'alice',
		{ providerOrder: [{ provider: 'spikonado', enabled: true }] },
		save
	);
	expect(localStorage.getItem(key)).toBeNull();
	expect(save).not.toHaveBeenCalled();
});
