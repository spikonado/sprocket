import { v, type Infer } from 'convex/values';

export const vInboxState = v.union(v.literal('unsettled'), v.literal('settled'));
export type InboxState = Infer<typeof vInboxState>;
export const INBOX_STATES = ['unsettled', 'settled'] as const;

export function inboxState(thread: { archivedAt?: number }): InboxState {
	return thread.archivedAt === undefined ? 'unsettled' : 'settled';
}
