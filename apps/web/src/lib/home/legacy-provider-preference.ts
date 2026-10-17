import { defaultProviderOrder, type ProviderOrderEntry } from '@convex/lib/providerOrder';

function readStored(key: string) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Moves the retired per-browser composer provider choice into the synced provider order. */
export function migrateLegacyProviderPreference(
	userId: string,
	preferences: { providerOrder?: ProviderOrderEntry[] } | null,
	saveProviderOrder: (args: { providerOrder: ProviderOrderEntry[] }) => Promise<null>
) {
	const key = `sprocket.composer.provider:${userId}`;
	const stored = readStored(key);

	if (stored === null) return;

	const forget = () => {
		try {
			localStorage.removeItem(key);
		} catch {
			// Retried on the next load.
		}
	};

	const preferred = stored === 'openai' || stored === 'chatgpt' ? stored : null;

	if (preferences?.providerOrder !== undefined || preferred === null) {
		forget();

		return;
	}

	const providerOrder: ProviderOrderEntry[] = [
		{ provider: preferred, enabled: true },
		...defaultProviderOrder.filter((entry) => entry.provider !== preferred)
	];

	void saveProviderOrder({ providerOrder }).then(forget, () => {});
}
