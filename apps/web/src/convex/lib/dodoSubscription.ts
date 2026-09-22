type SubscriptionTierSources = {
	checkoutTier: string | null;
	metadataTier: string | undefined;
	existingTier: string | null;
	configuredTier: string | null;
	legacyTier: string | undefined;
	preferConfiguredTier?: boolean;
};

export function resolveSubscriptionTier({
	checkoutTier,
	metadataTier,
	existingTier,
	configuredTier,
	legacyTier,
	preferConfiguredTier = false
}: SubscriptionTierSources): string | undefined {
	if (checkoutTier && metadataTier && checkoutTier !== metadataTier) {
		throw new Error('Dodo subscription tier metadata does not match its checkout reservation.');
	}
	if (checkoutTier) return checkoutTier;
	if (preferConfiguredTier) return configuredTier ?? legacyTier;
	return metadataTier ?? existingTier ?? configuredTier ?? legacyTier;
}
