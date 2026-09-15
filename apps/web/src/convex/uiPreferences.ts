import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Doc } from '@convex/_generated/dataModel';
import { getUserId } from '@convex/lib/auth';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import schema from '@convex/schema';

const vTheme = v.union(v.literal('light'), v.literal('dark'));

async function listPreferences(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'uiPreferences'>[]> {
	return await ctx.db
		.query('uiPreferences')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();
}

/** Earliest row wins so concurrent first-theme writes converge. */
function pickPreferences(rows: Array<Doc<'uiPreferences'>>): Doc<'uiPreferences'> | null {
	if (rows.length === 0) return null;
	return [...rows].sort(
		(a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id)
	)[0];
}

async function getPreferencesExclusive(
	ctx: MutationCtx,
	userId: string
): Promise<Doc<'uiPreferences'> | null> {
	const rows = await listPreferences(ctx, userId);
	const keep = pickPreferences(rows);
	if (!keep) return null;
	for (const row of rows) {
		if (row._id !== keep._id) await ctx.db.delete('uiPreferences', row._id);
	}
	return keep;
}

export const getMine = query({
	args: {},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		return pickPreferences(await listPreferences(ctx, userId));
	}
});

/** Retired session-restore write. Kept so older UIs get an update message. */
export const setLastThread = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const setTheme = mutation({
	args: {
		theme: vTheme
	},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const existing = await getPreferencesExclusive(ctx, userId);

		if (existing) {
			await ctx.db.patch('uiPreferences', existing._id, {
				theme: args.theme
			});
			return await ctx.db.get('uiPreferences', existing._id);
		}

		const id = await ctx.db.insert('uiPreferences', {
			userId,
			theme: args.theme
		});
		return await ctx.db.get('uiPreferences', id);
	}
});

/** Retired payments-email write. Kept so older settings screens get an update message. */
export const setPaymentsEmail = mutation({
	args: { email: v.string() },
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
