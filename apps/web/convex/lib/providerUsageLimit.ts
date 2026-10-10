import type { Doc } from '@convex/_generated/dataModel';
import { v } from 'convex/values';

export const vProviderUsageLimit = v.object({ resetsAt: v.optional(v.number()) });

export const vRunUsageLimit = v.object({
	retryAt: v.optional(v.number()),
	attempts: v.number(),
	deadlineAt: v.number()
});

export const MAX_USAGE_LIMIT_RESUMPTIONS = 8;

const USAGE_LIMIT_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

const FALLBACK_RETRY_MS = 15 * 60 * 1000;

const MAX_FALLBACK_RETRY_MS = 6 * 60 * 60 * 1000;

type UsageLimitRun = Pick<
	Doc<'runs'>,
	'status' | 'machineId' | 'completionProvider' | 'cancellationRequestedAt' | 'usageLimit'
>;

export function hasPendingUsageLimitResume(run: UsageLimitRun, now = Date.now()): boolean {
	const limit = run.usageLimit;

	return (
		run.status === 'failed' &&
		run.machineId !== undefined &&
		run.completionProvider === 'chatgpt' &&
		run.cancellationRequestedAt === undefined &&
		limit?.retryAt !== undefined &&
		limit.attempts < MAX_USAGE_LIMIT_RESUMPTIONS &&
		limit.retryAt <= limit.deadlineAt &&
		now <= limit.deadlineAt
	);
}

export function usageLimitAfterFailure(
	previous: Doc<'runs'>['usageLimit'],
	resetsAt: number | undefined,
	now: number,
	taskDeadlineAt?: number
): Doc<'runs'>['usageLimit'] {
	const attempts = previous?.attempts ?? 0;

	const deadlineAt = Math.min(
		previous?.deadlineAt ?? now + USAGE_LIMIT_WINDOW_MS,
		taskDeadlineAt ?? Infinity
	);

	const budget = { attempts, deadlineAt };

	if (attempts >= MAX_USAGE_LIMIT_RESUMPTIONS || now >= deadlineAt) return budget;

	const delay = Math.min(FALLBACK_RETRY_MS * 2 ** attempts, MAX_FALLBACK_RETRY_MS);

	const retryAt =
		resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > now
			? Math.max(now + 15_000, resetsAt + 5_000)
			: now + delay;

	return retryAt <= deadlineAt ? { ...budget, retryAt } : budget;
}
