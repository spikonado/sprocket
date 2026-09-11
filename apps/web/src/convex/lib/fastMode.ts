export type LegacyServiceTier = 'standard' | 'fast';

export function resolveFastMode(value: {
	fastMode?: boolean;
	serviceTier?: LegacyServiceTier;
}): boolean {
	return value.fastMode ?? value.serviceTier === 'fast';
}

export function legacyServiceTierForFastMode(fastMode: boolean): LegacyServiceTier {
	return fastMode ? 'fast' : 'standard';
}
