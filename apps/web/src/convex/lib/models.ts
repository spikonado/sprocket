export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;

export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type UsagePolicy = 'unlimited';

/** Fallback before the live gateway catalog loads. */
export const defaultModelId = 'deepseek-v4-pro-0813' as const;
export const defaultReasoningEffort: SupportedReasoningEffort = 'max';
export const defaultServiceTier: SupportedServiceTier = 'standard';

/** Removed from the catalog; rewrite these at read time until the migration finishes. */
export const retiredModelIds = [
	'stealth/ox-alpha',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'grok-4.5',
	'deepseek-v4-pro',
	'deepseek-v4-flash'
] as const;

const retiredModelReplacements = {
	'stealth/ox-alpha': 'deepseek-v4-pro-0813',
	'gpt-5.6-terra': 'gpt-5.6-sol',
	'gpt-5.6-luna': 'gpt-5.6-sol',
	'grok-4.5': 'gpt-5.6-sol',
	'deepseek-v4-pro': 'deepseek-v4-pro-0813',
	'deepseek-v4-flash': 'deepseek-v4-flash-0731'
} as const satisfies Record<(typeof retiredModelIds)[number], string>;

function isSupportedReasoningEffort(value: string): value is SupportedReasoningEffort {
	return reasoningEffortIds.some((effort) => effort === value);
}

function isSupportedServiceTier(value: string): value is SupportedServiceTier {
	return serviceTierIds.some((tier) => tier === value);
}

function retiredReplacement(modelId: string): string | undefined {
	for (const [retiredId, replacement] of Object.entries(retiredModelReplacements)) {
		if (retiredId === modelId) return replacement;
	}
	return undefined;
}

/** Rewrite retired stored model ids. Unknown gateway ids stay as-is. */
export function coercePersistedModelId(modelId: string): string {
	return retiredReplacement(modelId) ?? modelId;
}

export type PersistedModelSelection = {
	modelId: string;
	serviceTier: SupportedServiceTier;
};

/** Retired ids still stored on old runs. Per-model clamps happen against the live catalog. */
export function coercePersistedSelection(
	modelId: string,
	serviceTier: string
): PersistedModelSelection {
	return {
		modelId: coercePersistedModelId(modelId),
		serviceTier: isSupportedServiceTier(serviceTier) ? serviceTier : defaultServiceTier
	};
}

export function coercePersistedReasoningEffort(
	_modelId: string,
	reasoningEffort: SupportedReasoningEffort
): SupportedReasoningEffort {
	return isSupportedReasoningEffort(reasoningEffort) ? reasoningEffort : defaultReasoningEffort;
}
