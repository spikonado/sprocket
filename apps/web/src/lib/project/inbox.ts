import type { Doc } from '$convex/_generated/dataModel';
import { inboxState, runningStatus, type InboxState } from '$convex/lib/inboxState';

export function createProjectDefault(
	available: string[],
	filter: string[],
	recent: string[]
): string | null {
	const eligible = new Set(available.filter((key) => filter.length === 0 || filter.includes(key)));
	if (filter.length === 1) return eligible.has(filter[0]!) ? filter[0]! : null;
	return recent.find((key) => eligible.has(key)) ?? null;
}

export const INBOX_LABELS = {
	pinned: 'Pinned',
	active: 'Unsettled',
	snoozed: 'Snoozed',
	settled: 'Settled'
} satisfies Record<InboxState, string>;

export function compareInboxThreads(left: Doc<'threadRecords'>, right: Doc<'threadRecords'>) {
	const state = inboxState(left);
	const priority = state === 'pinned' || state === 'active';
	return (
		(priority ? Number(runningStatus(right.status)) - Number(runningStatus(left.status)) : 0) ||
		right.lastMessageAt - left.lastMessageAt ||
		right._creationTime - left._creationTime ||
		right._id.localeCompare(left._id)
	);
}

export function canChangeInboxState(thread: Doc<'threadRecords'>, target: InboxState) {
	if (
		(target === 'settled' || target === 'snoozed') &&
		(inboxState(thread) === 'pinned' || thread.hasPendingQuestion)
	)
		return false;
	return target !== 'settled' || !runningStatus(thread.status);
}

export function snoozePresets(now = new Date()) {
	const atMorning = (days: number) => {
		const date = new Date(now);
		date.setDate(date.getDate() + days);
		date.setHours(9, 0, 0, 0);
		return date.getTime();
	};
	const evening = new Date(now);
	evening.setHours(18, 0, 0, 0);
	const options = [
		{ label: 'In 1 hour', until: now.getTime() + 3_600_000 },
		{ label: 'In 3 hours', until: now.getTime() + 10_800_000 }
	];
	if (evening.getTime() - now.getTime() > 3_600_000)
		options.push({ label: 'This evening', until: evening.getTime() });
	options.push({ label: 'Tomorrow', until: atMorning(1) });
	const nextWeek = atMorning((8 - now.getDay()) % 7 || 7);
	if (nextWeek !== options.at(-1)?.until) options.push({ label: 'Next week', until: nextWeek });
	return options;
}

export function snoozeWakeLabel(until: number, now: number): string {
	const remaining = until - now;
	if (remaining <= 0) return 'now';
	if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)}m`;
	if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)}h`;
	return `${Math.ceil(remaining / 86_400_000)}d`;
}
