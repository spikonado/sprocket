type StoredServiceTier = 'standard' | 'fast';

export function fastModeForStoredRecord(value: {
	fastMode?: boolean;
	serviceTier?: StoredServiceTier;
}): boolean {
	return value.fastMode ?? value.serviceTier === 'fast';
}

export function normalizeStoredFastMode<
	T extends { fastMode?: boolean; serviceTier?: StoredServiceTier }
>(value: T): Omit<T, 'fastMode' | 'serviceTier'> & { fastMode: boolean } {
	const { fastMode, serviceTier, ...record } = value;
	return { ...record, fastMode: fastMode ?? serviceTier === 'fast' };
}
