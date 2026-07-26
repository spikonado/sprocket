import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import {
	completionProviders,
	credentialProviders,
	normalizeProviderPreference
} from '@convex/lib/providers';
import type { CompletionProviderId, CredentialProviderId } from '@convex/lib/validators';

export type ProviderCredentialStatus = {
	provider: CredentialProviderId;
	configured: boolean;
	keyHint: string | null;
	updatedAt: number | null;
};

export type UserProviderConfig = {
	providerPreference: CompletionProviderId[];
	availableProviders: Array<{ id: CompletionProviderId; configured: boolean }>;
	credentials: ProviderCredentialStatus[];
};

/** Preference order + credential configured flags for settings UI and agent runtime. */
export async function loadUserProviderConfig(
	ctx: MutationCtx | QueryCtx,
	userId: string
): Promise<UserProviderConfig> {
	const preferences = await ctx.db
		.query('providerPreferences')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();
	const providerPreference = normalizeProviderPreference(preferences?.providers);
	const credentials = await Promise.all(
		credentialProviders.map(async (provider) => {
			const ref = await ctx.db
				.query('providerCredentialRefs')
				.withIndex('by_userId_provider', (query) =>
					query.eq('userId', userId).eq('provider', provider)
				)
				.unique();
			return {
				provider,
				configured: ref !== null,
				keyHint: ref?.keyHint ?? null,
				updatedAt: ref?.updatedAt ?? null
			};
		})
	);
	const configured = new Set(
		credentials.filter((credential) => credential.configured).map((credential) => credential.provider)
	);
	return {
		providerPreference,
		credentials,
		availableProviders: completionProviders.map((id) => ({
			id,
			configured: id === 'convex' || configured.has(id)
		}))
	};
}
