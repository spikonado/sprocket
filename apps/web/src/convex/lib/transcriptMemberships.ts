import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';

export const MEMBERSHIP_MIGRATION = 'transcript-work-memberships-v1';

export async function ensureMembershipMigration(ctx: MutationCtx) {
	const existing = await ctx.db
		.query('migrationSchedules')
		.withIndex('by_name', (q) => q.eq('name', MEMBERSHIP_MIGRATION))
		.unique();
	if (existing) return;
	await ctx.db.insert('migrationSchedules', {
		name: MEMBERSHIP_MIGRATION,
		notBefore: Date.now()
	});
	await ctx.scheduler.runAfter(0, internal.migrations.runTranscriptMembershipMigration, {});
}

export async function getTranscriptMembership(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	number: number
) {
	return await ctx.db
		.query('threadTranscriptMemberships')
		.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId).eq('number', number))
		.unique();
}

export async function legacyMembershipPage(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>,
	start: number
) {
	const parts = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_number', (q) =>
			q
				.eq('threadId', threadId)
				.gte('number', start)
				.lt('number', start + 8)
		)
		.take(8);
	return await Promise.all(
		parts.map(async (part) => ({
			number: part.number,
			work: (await getTranscriptMembership(ctx, threadId, part.number))?.work ?? part.work ?? null
		}))
	);
}

export class WorkBatchParts {
	private readonly parts = new Map<number, Doc<'threadTranscriptParts'> | null>();
	private readonly membershipIds = new Map<number, Id<'threadTranscriptMemberships'> | null>();

	constructor(
		private readonly ctx: MutationCtx,
		private readonly threadId: Id<'threadRecords'>
	) {}

	async load(number: number): Promise<Doc<'threadTranscriptParts'> | null> {
		if (this.parts.has(number)) return this.parts.get(number) ?? null;
		const part = await this.ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (q) =>
				q.eq('threadId', this.threadId).eq('number', number)
			)
			.unique();
		if (!part) {
			this.parts.set(number, null);
			return null;
		}
		const membership = await getTranscriptMembership(this.ctx, this.threadId, number);
		this.membershipIds.set(number, membership?._id ?? null);
		const current = membership ? { ...part, work: membership.work } : part;
		this.parts.set(number, current);
		return current;
	}

	async save(part: Doc<'threadTranscriptParts'>, work: Doc<'threadTranscriptMemberships'>['work']) {
		const id = this.membershipIds.get(part.number);
		if (id === undefined) throw new Error('Work membership was not loaded.');
		if (id) {
			await this.ctx.db.patch('threadTranscriptMemberships', id, { work });
		} else {
			this.membershipIds.set(
				part.number,
				await this.ctx.db.insert('threadTranscriptMemberships', {
					threadId: this.threadId,
					number: part.number,
					work
				})
			);
		}
		this.parts.set(part.number, { ...part, work });
	}
}
