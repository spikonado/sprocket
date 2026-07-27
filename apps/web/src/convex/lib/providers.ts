import type { CompletionProviderId } from '@convex/lib/validators';

export const completionProviders = ['convex', 'chatgpt', 'openai'] as const;

/** Providers that store a user credential in Vault (not hosted `convex`). */
export const credentialProviders = ['chatgpt', 'openai'] as const;

export const VAULT_PROVIDER_KEY_CONTEXT = { dataType: 'provider_api_keys' } as const;

export function normalizeProviderPreference(
	providers: readonly string[] | undefined
): CompletionProviderId[] {
	const known = new Set<string>(completionProviders);
	const seen = new Set<CompletionProviderId>();
	const ordered: CompletionProviderId[] = [];
	for (const provider of providers ?? []) {
		if (!known.has(provider) || seen.has(provider as CompletionProviderId)) continue;
		const id = provider as CompletionProviderId;
		seen.add(id);
		ordered.push(id);
	}
	for (const provider of completionProviders) {
		if (!seen.has(provider)) ordered.push(provider);
	}
	return ordered;
}

export function keyHint(secret: string): string {
	const trimmed = secret.trim();
	return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

/** Validate Codex/ChatGPT auth.json and produce a stable Vault payload + hint. */
export function parseChatGPTAuth(value: string): { authJson: string; keyHint: string } {
	let record: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(value.trim());
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('expected object');
		}
		record = parsed as Record<string, unknown>;
	} catch {
		throw new Error('ChatGPT auth must be a JSON object (Codex auth.json).');
	}
	const access = typeof record.access_token === 'string' ? record.access_token.trim() : '';
	const refresh = typeof record.refresh_token === 'string' ? record.refresh_token.trim() : '';
	if (!access && !refresh) {
		throw new Error('ChatGPT auth.json must include an access_token or refresh_token.');
	}
	const hintSource =
		(typeof record.account_id === 'string' && record.account_id.trim()) || refresh || access;
	return { authJson: JSON.stringify(record), keyHint: keyHint(hintSource) };
}
