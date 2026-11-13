import type { ServiceTier } from '@convex/lib/validators';

export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function modelServiceTier(settings: {
	serviceTier?: ServiceTier;
	fastMode?: boolean;
}): ServiceTier {
	return settings.serviceTier ?? (settings.fastMode ? 'fast' : 'standard');
}

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];

export type UsagePolicy = 'unlimited';

export function normalizeTaskTimeoutMs(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;

	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error('Timeout must be a non-negative number of milliseconds.');
	}

	return Math.max(1, Math.floor(timeoutMs));
}
