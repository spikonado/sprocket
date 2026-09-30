import { v, type Infer } from 'convex/values';

export const vInboxState = v.union(v.literal('unsettled'), v.literal('settled'));
export type InboxState = Infer<typeof vInboxState>;
export const INBOX_STATES = ['unsettled', 'settled'] as const;
export const MAX_INBOX_REPOSITORIES = 200;

export function inboxState(thread: { archivedAt?: number }): InboxState {
	return thread.archivedAt === undefined ? 'unsettled' : 'settled';
}
