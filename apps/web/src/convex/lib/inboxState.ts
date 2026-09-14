import { v, type Infer } from 'convex/values';

export const vInboxState = v.union(
	v.literal('active'),
	v.literal('pinned'),
	v.literal('snoozed'),
	v.literal('settled')
);
export type InboxState = Infer<typeof vInboxState>;
export const INBOX_STATES = ['pinned', 'active', 'snoozed', 'settled'] as const;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export function inboxState(thread: { inboxState?: InboxState; archivedAt?: number }): InboxState {
	return thread.inboxState ?? (thread.archivedAt === undefined ? 'active' : 'settled');
}

export function runningStatus(status?: string): boolean {
	return status === 'queued' || status === 'running' || status === 'awaiting_executor';
}
