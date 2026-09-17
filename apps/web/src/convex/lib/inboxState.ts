import { internal } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';

export const vInboxState = v.union(v.literal('unsettled'), v.literal('settled'));
export type InboxState = Infer<typeof vInboxState>;
export const INBOX_STATES = ['unsettled', 'settled'] as const;
export const MAX_INBOX_REPOSITORIES = 200;
export const INBOX_WORKING_MIGRATION = 'inbox-working-v1';

export function inboxState(thread: { archivedAt?: number }): InboxState {
	return thread.archivedAt === undefined ? 'unsettled' : 'settled';
}

export function inboxWorking(status: string | null | undefined): boolean {
	return status === 'queued' || status === 'running';
}

export async function ensureInboxWorkingMigration(ctx: MutationCtx) {
	const existing = await ctx.db
		.query('migrationSchedules')
		.withIndex('by_name', (q) => q.eq('name', INBOX_WORKING_MIGRATION))
		.unique();
	if (existing) return;
	await ctx.db.insert('migrationSchedules', {
		name: INBOX_WORKING_MIGRATION,
		notBefore: Date.now()
	});
	await ctx.scheduler.runAfter(0, internal.migrations.runInboxWorkingMigration, {});
}
