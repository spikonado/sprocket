import { mutation, query, type QueryCtx } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { commandSnapshot } from '@convex/lib/commandSessions';
import schema from '@convex/schema';

async function findSession(ctx: QueryCtx, threadId: Id<'threadRecords'>, sessionId: string) {
	return await ctx.db
		.query('commandSessions')
		.withIndex('by_threadId_and_sessionId', (q) =>
			q.eq('threadId', threadId).eq('sessionId', sessionId)
		)
		.unique();
}

function validateOffset(offset: number) {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid command log offset.');
}

export const sync = mutation({
	args: {
		threadId: v.id('threadRecords'),
		sessionId: v.string(),
		snapshot: commandSnapshot,
		chunks: v.array(v.object({ offset: v.number(), bytes: v.bytes() }))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args.sessionId))
			throw new Error('Invalid command session ID.');

		if (args.chunks.length > 4) throw new Error('Command log batch is too large.');

		if (new TextEncoder().encode(args.snapshot.result.output).length > 320_000)
			throw new Error('Command preview is too large.');
		const session = await findSession(ctx, args.threadId, args.sessionId);

		const commandId =
			session?._id ??
			(await ctx.db.insert('commandSessions', {
				threadId: args.threadId,
				userId,
				sessionId: args.sessionId,
				...args.snapshot,
				eventsBytes: 0
			}));

		if (
			session &&
			(session.machineId !== args.snapshot.machineId ||
				session.command !== args.snapshot.command ||
				session.workdir !== args.snapshot.workdir)
		)
			throw new Error('Command session identity cannot change.');
		let eventsBytes = session?.eventsBytes ?? 0;

		for (const chunk of args.chunks) {
			validateOffset(chunk.offset);

			if (chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > 128 * 1024)
				throw new Error('Invalid command log chunk size.');

			if (chunk.offset < eventsBytes) {
				const previous = await ctx.db
					.query('commandLogChunks')
					.withIndex('by_commandId_offset', (q) =>
						q.eq('commandId', commandId).eq('offset', chunk.offset)
					)
					.unique();

				const bytes = new Uint8Array(chunk.bytes);

				if (
					!previous ||
					previous.bytes.byteLength !== bytes.length ||
					!new Uint8Array(previous.bytes).every((byte, index) => byte === bytes[index])
				)
					throw new Error('Command log retry does not match saved bytes.');
				continue;
			}

			if (chunk.offset !== eventsBytes) throw new Error('Command log chunk is out of order.');

			if (session && !session.result.running)
				throw new Error('Completed command logs cannot change.');
			await ctx.db.insert('commandLogChunks', { commandId, ...chunk });

			eventsBytes += chunk.bytes.byteLength;
		}

		if (eventsBytes > 64 * 1024 * 1024) throw new Error('Command log quota exceeded.');

		if (!session || session.result.running)
			await ctx.db.patch('commandSessions', commandId, {
				result: args.snapshot.result,
				eventsBytes
			});

		return null;
	}
});

export const get = query({
	args: { threadId: v.id('threadRecords'), sessionId: v.string() },
	returns: v.union(schema.doc('commandSessions'), v.null()),
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		return await findSession(ctx, args.threadId, args.sessionId);
	}
});

export const getLogChunks = query({
	args: {
		threadId: v.id('threadRecords'),
		sessionId: v.string(),
		offset: v.number()
	},
	returns: v.array(schema.doc('commandLogChunks')),
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);
		validateOffset(args.offset);
		const session = await findSession(ctx, args.threadId, args.sessionId);

		if (!session) return [];

		const previous = await ctx.db
			.query('commandLogChunks')
			.withIndex('by_commandId_offset', (q) =>
				q.eq('commandId', session._id).lte('offset', args.offset)
			)
			.order('desc')
			.first();

		const containing =
			previous && previous.offset + previous.bytes.byteLength > args.offset ? previous : null;

		const next = await ctx.db
			.query('commandLogChunks')
			.withIndex('by_commandId_offset', (q) =>
				q.eq('commandId', session._id).gt('offset', containing?.offset ?? args.offset - 1)
			)
			.take(containing ? 3 : 4);

		return containing ? [containing, ...next] : next;
	}
});
