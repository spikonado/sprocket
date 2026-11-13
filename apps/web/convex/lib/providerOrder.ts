import { v, type Infer } from 'convex/values';
import { vCompletionProvider, type CompletionProvider } from '@convex/lib/validators';

export const vProviderOrderEntry = v.object({
	provider: vCompletionProvider,
	enabled: v.boolean()
});

export type ProviderOrderEntry = Infer<typeof vProviderOrderEntry>;

/** Released clients omit `knownProviders` and reject any provider outside this list. */
export const releasedClientProviders: readonly CompletionProvider[] = [
	'spikonado',
	'openai',
	'chatgpt'
];

export const builtInProvider: CompletionProvider = 'spikonado';

export const defaultProviderOrder: readonly ProviderOrderEntry[] = [
	{ provider: builtInProvider, enabled: true }
];

export function resolveProviderOrder(
	saved: readonly ProviderOrderEntry[] | undefined
): ProviderOrderEntry[] {
	return [...(saved ?? defaultProviderOrder)];
}

export function withProviderEnabled(
	order: readonly ProviderOrderEntry[],
	provider: CompletionProvider
): ProviderOrderEntry[] {
	if (!order.some((entry) => entry.provider === provider)) {
		return [...order, { provider, enabled: true }];
	}

	return order.map((entry) => (entry.provider === provider ? { ...entry, enabled: true } : entry));
}

export function withoutProvider(
	order: readonly ProviderOrderEntry[],
	provider: CompletionProvider
): ProviderOrderEntry[] {
	const remaining = order.filter((entry) => entry.provider !== provider);

	return remaining.some((entry) => entry.enabled)
		? remaining
		: withProviderEnabled(remaining, builtInProvider);
}

export function enabledProviders(
	saved: readonly ProviderOrderEntry[] | undefined,
	knownProviders: readonly CompletionProvider[]
) {
	return resolveProviderOrder(saved)
		.filter((entry) => entry.enabled && knownProviders.includes(entry.provider))
		.map((entry) => entry.provider);
}

export function assertValidProviderOrder(order: readonly ProviderOrderEntry[]) {
	const providers = new Set(order.map((entry) => entry.provider));

	if (
		providers.size !== order.length ||
		!providers.has(builtInProvider) ||
		!order.some((entry) => entry.enabled)
	) {
		throw new Error(
			'Provider order must list each provider once, include Spikonado, and have at least one enabled.'
		);
	}
}
