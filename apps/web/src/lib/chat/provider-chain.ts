import {
	enabledProviders,
	providerServesVendor,
	type ProviderOrderEntry
} from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';

export const completionProviderLabels: Record<CompletionProvider, string> = {
	spikonado: 'Spikonado',
	openai: 'OpenAI API',
	chatgpt: 'ChatGPT Subscription'
};

/** Enabled providers the user has set up, in their preferred order. */
export function usableProviders(
	providerOrder: readonly ProviderOrderEntry[] | undefined,
	configuredProviders: readonly CompletionProvider[]
): CompletionProvider[] {
	return enabledProviders(providerOrder).filter((provider) =>
		configuredProviders.includes(provider)
	);
}

export function providerChainForModel(
	providers: readonly CompletionProvider[],
	model: { provider: string } | undefined
): CompletionProvider[] {
	return model
		? providers.filter((provider) => providerServesVendor(provider, model.provider))
		: [];
}
