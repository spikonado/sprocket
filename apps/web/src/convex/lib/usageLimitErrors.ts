import { usageMeters, type UsageMeterId, type UsagePeriod } from '@convex/lib/usageMeters';

/**
 * Executor error wrapping can add text around run failure messages, so clients
 * detect exhausted-usage failures by this prefix instead of exact equality.
 */
export const USAGE_LIMIT_EXCEEDED_PREFIX = 'Usage limit exceeded: ';

export type UsageWindowStatus = {
	period: UsagePeriod;
	used: number;
	limit: number;
	resetsAt: number | null;
};

export type UsageMeterStatus = {
	id: string;
	windows: UsageWindowStatus[];
};

export function usageLimitExhaustedMessage(args: {
	meterId: UsageMeterId;
	period: UsagePeriod;
	resetsIn: string;
}): string {
	return USAGE_LIMIT_EXCEEDED_PREFIX + usageLimitExhaustedSentence(args);
}

export function usageLimitExhaustedSentence(args: {
	meterId: UsageMeterId;
	period: UsagePeriod;
	resetsIn?: string;
}): string {
	const meter = usageMeters.find((candidate) => candidate.id === args.meterId);
	if (!meter) throw new Error(`Unknown usage meter: ${args.meterId}`);
	const periodLabel = args.period === 'weekly' ? 'weekly' : 'monthly';
	const resetSuffix = args.resetsIn ? ` Your limit resets in ${args.resetsIn}.` : '';
	return `You've used all of your ${periodLabel} ${meter.noun}.${resetSuffix}`;
}

/** Readable sentence after the prefix, or null when the failure is not a usage limit. */
export function extractUsageLimitExceededMessage(message: string): string | null {
	const startIndex = message.indexOf(USAGE_LIMIT_EXCEEDED_PREFIX);
	if (startIndex === -1) return null;
	const detail = message.slice(startIndex + USAGE_LIMIT_EXCEEDED_PREFIX.length);
	const lineBreak = detail.indexOf('\n');
	return lineBreak === -1 ? detail : detail.slice(0, lineBreak);
}

/**
 * The exhausted window that unlocks last, mirroring checkMeterLimits picking
 * the blocked period with the longest retryAfter. Zero limits (disabled meters)
 * never block.
 */
export function pickExhaustedUsageWindow(
	meters: readonly UsageMeterStatus[]
): { meterId: UsageMeterId; period: UsagePeriod; resetsAt: number | null } | null {
	let blocked: { meterId: UsageMeterId; period: UsagePeriod; resetsAt: number | null } | null =
		null;
	for (const meter of meters) {
		for (const window of meter.windows) {
			if (window.limit <= 0 || window.used < window.limit) continue;
			if (blocked === null || (window.resetsAt ?? Infinity) > (blocked.resetsAt ?? Infinity)) {
				blocked = {
					meterId: meter.id as UsageMeterId,
					period: window.period,
					resetsAt: window.resetsAt
				};
			}
		}
	}
	return blocked;
}
