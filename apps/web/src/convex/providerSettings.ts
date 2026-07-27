import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { loadUserProviderConfig } from '@convex/lib/providerConfig';
import { normalizeProviderPreference } from '@convex/lib/providers';
import {
	vCompletionProviderId,
	type CompletionProviderId
} from '@convex/lib/validators';

export const getMine = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const { providerPreference, credentials } = await loadUserProviderConfig(ctx, userId);
		return {
			providers: providerPreference,
			credentials
		};
	}
});

export const setProviderOrder = mutation({
	args: {
		providers: v.array(vCompletionProviderId)
	},
	handler: async (ctx, args): Promise<{ providers: CompletionProviderId[] }> => {
		const userId = await getUserId(ctx);
		if (args.providers.length === 0) {
			throw new Error('At least one provider is required.');
		}
		const providers = normalizeProviderPreference(args.providers);
		const existing = await ctx.db
			.query('providerPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, { providers });
		} else {
			await ctx.db.insert('providerPreferences', { userId, providers });
		}
		return { providers };
	}
});
