type SubscriptionTierSources = {
	checkoutTier: string | null;
	metadataTier: string | undefined;
	existingTier: string | null;
	configuredTier: string | null;
	preferConfiguredTier?: boolean;
};

export function resolveSubscriptionTier({
	checkoutTier,
	metadataTier,
	existingTier,
	configuredTier,
	preferConfiguredTier = false
}: SubscriptionTierSources): string | undefined {
	if (checkoutTier && metadataTier && checkoutTier !== metadataTier) {
		throw new Error('Dodo subscription tier metadata does not match its checkout reservation.');
	}
	if (checkoutTier) return checkoutTier;
	if (preferConfiguredTier) return configuredTier ?? undefined;
	return existingTier ?? metadataTier ?? configuredTier ?? undefined;
}
