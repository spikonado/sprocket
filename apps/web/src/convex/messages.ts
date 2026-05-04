import { paginationOptsValidator } from 'convex/server';
import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getActorId } from '@convex/lib/auth';
import { listThreadMessages } from '@convex/lib/threadMessages';

export const listForThread = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string(),
		paginationOpts: paginationOptsValidator
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		await getOwnedThreadRecord(ctx.db, actorId, args.threadId);
		const allMessages = await listThreadMessages(ctx, args.threadId);
		const total = allMessages.length;
		const requested = Math.max(1, args.paginationOpts.numItems);
		const endExclusive =
			args.paginationOpts.cursor == null ? total : Math.max(0, Number(args.paginationOpts.cursor));
		const start = Math.max(0, endExclusive - requested);
		const page = allMessages.slice(start, endExclusive);
		return {
			page,
			isDone: start === 0,
			continueCursor: start === 0 ? null : String(start),
			pageStatus: null,
			splitCursor: null
		};
	}
});
