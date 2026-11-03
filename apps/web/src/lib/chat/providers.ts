import type { ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';

export const completionProviderLabels: Record<CompletionProvider, string> = {
	spikonado: 'Spikonado',
	openai: 'OpenAI API',
	chatgpt: 'ChatGPT Subscription'
};

/** Applies a new order of the shown providers, keeping hidden ones in their slots. */
export function reorderShownProviders(
	order: readonly ProviderOrderEntry[],
	shownOrder: readonly CompletionProvider[]
): ProviderOrderEntry[] {
	const shown = shownOrder.flatMap((provider) =>
		order.filter((entry) => entry.provider === provider)
	);

	let next = 0;

	return order.map((entry) => (shownOrder.includes(entry.provider) ? shown[next++] : entry));
}
