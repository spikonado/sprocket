import { usageMeters, type UsageMeterId, type UsagePeriod } from '@convex/lib/usageMeters';

/**
 * Executor error wrapping can add text around run failure messages, so clients
 * detect exhausted-usage failures by this prefix instead of exact equality.
 */
export const USAGE_LIMIT_EXCEEDED_PREFIX = 'Usage limit exceeded: ';

export function usageLimitExhaustedMessage(args: {
	meterId: UsageMeterId;
	period: UsagePeriod;
	resetsIn: string;
}): string {
	const meter = usageMeters.find((candidate) => candidate.id === args.meterId);
	if (!meter) throw new Error(`Unknown usage meter: ${args.meterId}`);
	const periodLabel = args.period === 'weekly' ? 'weekly' : 'monthly';
	return `${USAGE_LIMIT_EXCEEDED_PREFIX}You've used all of your ${periodLabel} ${meter.noun}. Your limit resets in ${args.resetsIn}.`;
}

/** Readable sentence after the prefix, or null when the failure is not a usage limit. */
export function extractUsageLimitExceededMessage(message: string): string | null {
	const startIndex = message.indexOf(USAGE_LIMIT_EXCEEDED_PREFIX);
	if (startIndex === -1) return null;
	const detail = message.slice(startIndex + USAGE_LIMIT_EXCEEDED_PREFIX.length);
	const lineBreak = detail.indexOf('\n');
	return lineBreak === -1 ? detail : detail.slice(0, lineBreak);
}
