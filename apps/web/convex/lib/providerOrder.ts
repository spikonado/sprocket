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

export const defaultProviderOrder: readonly ProviderOrderEntry[] = completionProviderIds.map(
	(provider) => ({ provider, enabled: true })
);

/** Saved order with any provider missing from it appended, enabled, in default order. */
export function resolveProviderOrder(
	saved: readonly ProviderOrderEntry[] | undefined
): ProviderOrderEntry[] {
	const order = (saved ?? []).filter(
		(entry, index, entries) =>
			entries.findIndex((other) => other.provider === entry.provider) === index
	);

	for (const entry of defaultProviderOrder) {
		if (!order.some((other) => other.provider === entry.provider)) order.push({ ...entry });
	}

	return order;
}

export function enabledProviders(saved: readonly ProviderOrderEntry[] | undefined) {
	return resolveProviderOrder(saved)
		.filter((entry) => entry.enabled)
		.map((entry) => entry.provider);
}

export function assertValidProviderOrder(order: readonly ProviderOrderEntry[]) {
	const providers = new Set(order.map((entry) => entry.provider));

	if (
		providers.size !== order.length ||
		providers.size !== completionProviderIds.length ||
		!order.some((entry) => entry.enabled)
	) {
		throw new Error('Provider order must list every provider once with at least one enabled.');
	}
}

/** BYOK/BYOS providers only serve models whose catalog vendor is OpenAI. */
export function providerServesVendor(provider: CompletionProvider, vendor: string) {
	return provider === 'spikonado' || vendor === 'openai';
}

export function assertValidProviderChain(chain: readonly CompletionProvider[]) {
	if (chain.length === 0 || new Set(chain).size !== chain.length) {
		throw new Error('A run needs at least one provider, each listed once.');
	}
}
