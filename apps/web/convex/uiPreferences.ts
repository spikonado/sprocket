import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import type { WithoutSystemFields } from 'convex/server';
import { v } from 'convex/values';
import type { Doc } from '@convex/_generated/dataModel';
import { getUserId } from '@convex/lib/auth';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { assertValidProviderOrder, vProviderOrderEntry } from '@convex/lib/providerOrder';
import schema from '@convex/schema';

const vTheme = v.union(v.literal('light'), v.literal('dark'));

async function savePreferences(
	ctx: MutationCtx,
	changes: Partial<Omit<WithoutSystemFields<Doc<'uiPreferences'>>, 'userId'>>
) {
	const userId = await getUserId(ctx);
	const existing = await getUiPreferences(ctx.db, userId);

	if (existing) {
		await ctx.db.patch('uiPreferences', existing._id, changes);

		return existing._id;
	}

	return await ctx.db.insert('uiPreferences', { userId, theme: 'light', ...changes });
}

export const setAutomaticAgentContinuation = mutation({
	args: { enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await savePreferences(ctx, { automaticAgentContinuation: args.enabled });

		return null;
	}
});

export const setAutomaticThreadTitles = mutation({
	args: { enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await savePreferences(ctx, { automaticThreadTitles: args.enabled });

		return null;
	}
});

async function clearPendingMergedSettles(ctx: MutationCtx, userId: string) {
	const threads = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_lastMessageAt', (q) => q.eq('userId', userId))
		.collect();

	for (const thread of threads) {
		if (!thread.settleWhenIdle) continue;

		await ctx.db.patch('threadRecords', thread._id, { settleWhenIdle: undefined });
	}
}

export const setSettleMergedThreads = mutation({
	args: { enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await savePreferences(ctx, { settleMergedThreads: args.enabled });

		if (!args.enabled) {
			await clearPendingMergedSettles(ctx, await getUserId(ctx));
		}

		return null;
	}
});

export const setProviderOrder = mutation({
	args: { providerOrder: v.array(vProviderOrderEntry) },
	returns: v.null(),
	handler: async (ctx, args) => {
		assertValidProviderOrder(args.providerOrder);
		await savePreferences(ctx, { providerOrder: args.providerOrder });

		return null;
	}
});

export const setRestrictSubagentsToProvider = mutation({
	args: { enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await savePreferences(ctx, { restrictSubagentsToProvider: args.enabled });

		return null;
	}
});

export const getMine = query({
	args: {},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx) => {
		return await getUiPreferences(ctx.db, await getUserId(ctx));
	}
});

export const setTheme = mutation({
	args: {
		theme: vTheme
	},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx, args) => {
		const id = await savePreferences(ctx, { theme: args.theme });

		return await ctx.db.get('uiPreferences', id);
	}
});
