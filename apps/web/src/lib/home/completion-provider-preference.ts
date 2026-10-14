import type { CompletionProvider } from '@convex/lib/validators';

function storageKey(userId: string) {
	return `sprocket.composer.provider:${userId}`;
}

export function readCompletionProviderPreference(userId: string | null): CompletionProvider {
	if (!userId) return 'spikonado';

	try {
		const stored = localStorage.getItem(storageKey(userId));

		return stored === 'openai' || stored === 'chatgpt' ? stored : 'spikonado';
	} catch {
		return 'spikonado';
	}
}

export function storeCompletionProviderPreference(userId: string, provider: CompletionProvider) {
	try {
		localStorage.setItem(storageKey(userId), provider);
	} catch {
		// Keep the in-memory preference when browser storage is unavailable.
	}
}
