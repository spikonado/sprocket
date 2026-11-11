import { v, type Infer } from 'convex/values';
import {
	completionProviderIds,
	vCompletionProvider,
	type CompletionProvider
} from '@convex/lib/validators';

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

export const defaultProviderOrder: readonly ProviderOrderEntry[] = completionProviderIds.map(
	(provider) => ({ provider, enabled: provider === 'spikonado' })
);

export function resolveProviderOrder(
	saved: readonly ProviderOrderEntry[] | undefined
): ProviderOrderEntry[] {
	const order = [...(saved ?? [])];

	for (const entry of defaultProviderOrder) {
		if (!order.some((other) => other.provider === entry.provider)) order.push({ ...entry });
	}

	return order;
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

	if (providers.size !== order.length || !order.some((entry) => entry.enabled)) {
		throw new Error('Provider order must list each provider once with at least one enabled.');
	}
}
