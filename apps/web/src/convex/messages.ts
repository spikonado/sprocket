import { paginationOptsValidator } from 'convex/server';
import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { buildThreadTranscript, type ThreadTranscriptMessage } from '@convex/lib/threadTranscript';

export const listForThread = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.id('threadRecords'),
		paginationOpts: paginationOptsValidator
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const allMessages: ThreadTranscriptMessage[] = await buildThreadTranscript(ctx, args.threadId);
		const total: number = allMessages.length;
		const requested: number = Math.max(1, args.paginationOpts.numItems);
		const endExclusive: number =
			args.paginationOpts.cursor == null ? total : Math.max(0, Number(args.paginationOpts.cursor));
		const start: number = Math.max(0, endExclusive - requested);
		const page: ThreadTranscriptMessage[] = allMessages.slice(start, endExclusive);
		return {
			threadId: args.threadId,
			page,
			isDone: start === 0,
			continueCursor: start === 0 ? null : String(start),
			pageStatus: null,
			splitCursor: null
		};
	}
});
